import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { recordAttributionVisit } from "./attributions";
import type { QueryRunner } from "./db";
import type { VisitInput } from "@/domain/attribution/attribution";

/**
 * Which advertising gets the credit for a sale.
 *
 * Two rules decide whether these numbers are usable or quietly flattering, and
 * both are asserted here against the real table:
 *
 *   first touch is NEVER overwritten
 *   a direct return NEVER replaces last touch
 *
 * Get either wrong and a working campaign disappears from its own report while
 * the spend carries on.
 *
 * (The migration loader below uses the PGlite multi-statement SQL entry point.
 * It is a SQL executor, unrelated to child_process despite the name an editor
 * security reminder matches on.)
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const SITE_HOST = "example.com";

let db: PGlite;
let runner: QueryRunner;

beforeAll(async () => {
  db = await PGlite.create();
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  runner = db as unknown as QueryRunner;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const visit = (overrides: Partial<VisitInput> = {}): VisitInput => ({
  url: "https://example.com/training",
  referrer: null,
  siteHost: SITE_HOST,
  anonymousSessionId: "session-default",
  now: new Date("2027-07-01T10:00:00Z"),
  ...overrides,
});

interface Row {
  first_touch_source: string | null;
  first_touch_medium: string | null;
  first_touch_campaign: string | null;
  last_touch_source: string | null;
  last_touch_medium: string | null;
  gclid: string | null;
  landing_page: string;
  last_seen_at: Date;
}

const rowFor = (sessionId: string) =>
  db
    .query<Row>("select * from attributions where anonymous_session_id = $1", [sessionId])
    .then((r) => r.rows[0]);

const countFor = (sessionId: string) =>
  db
    .query<{ n: number }>(
      "select count(*)::int as n from attributions where anonymous_session_id = $1",
      [sessionId],
    )
    .then((r) => r.rows[0]?.n ?? 0);

describe("recordAttributionVisit", () => {
  it("records a first visit and says it is the first", async () => {
    const stored = await recordAttributionVisit(
      runner,
      visit({
        anonymousSessionId: "s-first",
        url: "https://example.com/training?utm_source=google&utm_medium=cpc&utm_campaign=launch",
      }),
    );

    expect(stored.isFirstVisit).toBe(true);

    const row = await rowFor("s-first");
    expect(row?.first_touch_source).toBe("google");
    expect(row?.first_touch_medium).toBe("cpc");
    expect(row?.first_touch_campaign).toBe("launch");
    // Path and query only. The host is ours, and storing it says nothing.
    expect(row?.landing_page).toBe(
      "/training?utm_source=google&utm_medium=cpc&utm_campaign=launch",
    );
  });

  /*
    THE rule. Letting a later visit overwrite first touch credits the channel
    that closed the sale with the work of the one that started it.
  */
  it("never overwrites first touch, however somebody comes back", async () => {
    const id = "s-first-touch-held";
    await recordAttributionVisit(
      runner,
      visit({
        anonymousSessionId: id,
        url: "https://example.com/training?utm_source=google&utm_medium=cpc&utm_campaign=launch",
      }),
    );

    await recordAttributionVisit(
      runner,
      visit({
        anonymousSessionId: id,
        url: "https://example.com/training?utm_source=newsletter&utm_medium=email",
        now: new Date("2027-07-05T10:00:00Z"),
      }),
    );

    const row = await rowFor(id);
    expect(row?.first_touch_source).toBe("google");
    expect(row?.first_touch_medium).toBe("cpc");
    expect(row?.first_touch_campaign).toBe("launch");
    // Last touch did move - that is the half that is supposed to.
    expect(row?.last_touch_source).toBe("newsletter");
    expect(row?.last_touch_medium).toBe("email");
  });

  /*
    Somebody who clicks an ad on Monday and types the address on Thursday was
    still brought in by that ad. Treating Thursday as a fresh direct arrival is
    how a working campaign vanishes from its own report.
  */
  it("does not let a direct return replace last touch", async () => {
    const id = "s-direct-return";
    await recordAttributionVisit(
      runner,
      visit({
        anonymousSessionId: id,
        url: "https://example.com/training?utm_source=google&utm_medium=cpc",
      }),
    );

    await recordAttributionVisit(
      runner,
      visit({
        anonymousSessionId: id,
        url: "https://example.com/training",
        referrer: null,
        now: new Date("2027-07-04T10:00:00Z"),
      }),
    );

    const row = await rowFor(id);
    expect(row?.last_touch_source).toBe("google");
    expect(row?.last_touch_medium).toBe("cpc");
    // The visit still counts as a visit, even though it changed no credit.
    expect(row?.last_seen_at.toISOString()).toBe("2027-07-04T10:00:00.000Z");
  });

  it("does not let a click between our own pages replace last touch", async () => {
    const id = "s-internal";
    await recordAttributionVisit(
      runner,
      visit({
        anonymousSessionId: id,
        url: "https://example.com/training?utm_source=google&utm_medium=cpc",
      }),
    );

    await recordAttributionVisit(
      runner,
      visit({
        anonymousSessionId: id,
        url: "https://example.com/training/book/ai-foundations",
        referrer: "https://example.com/training",
        now: new Date("2027-07-02T10:00:00Z"),
      }),
    );

    expect((await rowFor(id))?.last_touch_source).toBe("google");
  });

  // A bare gclid is a paid Google click - auto-tagging sends no utm at all.
  it("reads a bare gclid as a paid Google click", async () => {
    const id = "s-gclid";
    await recordAttributionVisit(
      runner,
      visit({ anonymousSessionId: id, url: "https://example.com/training?gclid=abc123" }),
    );

    const row = await rowFor(id);
    expect(row?.first_touch_source).toBe("google");
    expect(row?.first_touch_medium).toBe("cpc");
    expect(row?.gclid).toBe("abc123");
  });

  it("keeps an older click id rather than discarding it for nothing", async () => {
    const id = "s-clickid";
    await recordAttributionVisit(
      runner,
      visit({ anonymousSessionId: id, url: "https://example.com/training?gclid=first-click" }),
    );
    await recordAttributionVisit(
      runner,
      visit({
        anonymousSessionId: id,
        url: "https://example.com/training",
        now: new Date("2027-07-03T10:00:00Z"),
      }),
    );

    expect((await rowFor(id))?.gclid).toBe("first-click");
  });

  /*
    A page load and a prefetch can arrive together. Check-then-act would give
    that browser two first touches, and which one an order linked to would be a
    coin toss. The unique index is what settles it.
  */
  it("gives one browser exactly one row, even when visits arrive together", async () => {
    const id = "s-concurrent";

    const results = await Promise.all([
      recordAttributionVisit(
        runner,
        visit({
          anonymousSessionId: id,
          url: "https://example.com/training?utm_source=google&utm_medium=cpc",
        }),
      ),
      recordAttributionVisit(
        runner,
        visit({
          anonymousSessionId: id,
          url: "https://example.com/training?utm_source=bing&utm_medium=cpc",
        }),
      ),
    ]);

    expect(await countFor(id)).toBe(1);
    // Exactly one of them created it; the other continued as a return visit.
    expect(results.filter((r) => r.isFirstVisit)).toHaveLength(1);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
  });

  it("stores an arrival with no campaign at all as direct", async () => {
    const id = "s-plain";
    await recordAttributionVisit(runner, visit({ anonymousSessionId: id }));

    const row = await rowFor(id);
    expect(row?.first_touch_source).toBe("direct");
    expect(row?.first_touch_medium).toBe("none");
  });

  // Every field arrives in a query string anybody can write.
  it("caps a hostile campaign value rather than storing it whole", async () => {
    const id = "s-long";
    const enormous = "a".repeat(5000);
    await recordAttributionVisit(
      runner,
      visit({
        anonymousSessionId: id,
        url: "https://example.com/training?utm_source=x&utm_campaign=" + enormous,
      }),
    );

    expect((await rowFor(id))?.first_touch_campaign?.length).toBe(200);
  });
});

describe("the attribution schema", () => {
  /*
    Attempted rather than read. SQL judged correct by eye is not verified SQL -
    the same standard the first migration was held to.
  */
  it("refuses a second row for the same browser", async () => {
    const insert = (page: string) =>
      db.query("insert into attributions (landing_page, anonymous_session_id) values ($1, $2)", [
        page,
        "duplicate-me",
      ]);

    await insert("/x");
    await expect(insert("/y")).rejects.toThrow();
  });
});
