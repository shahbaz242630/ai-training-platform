import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { QueryRunner } from "@/data/db";
import { MAX_LIVE_HOLDS } from "@/domain/booking/slot-hold";
import { MockEmailProvider } from "@/domain/messaging/mock-provider";
import { HOLDS_CLEAR_SHARE, HOLDS_WARNING_SHARE, protectionAlerts } from "./protection-step";

/**
 * The sweep's watch on the booking's own protections (audit s104): a diary
 * filling with unpaid holds, and a database filling up, both told to the desk
 * by email, once a day while they last, and closed quietly once they are gone.
 */

let db: PGlite;
let mail: MockEmailProvider;
const NOW = new Date("2026-10-21T12:00:00Z");
const DESK = "desk@example.com";
const WARN_AT = Math.ceil(MAX_LIVE_HOLDS * HOLDS_WARNING_SHARE);

beforeAll(async () => {
  db = await PGlite.create();
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.query(`delete from slot_holds`);
  await db.query(`delete from desk_alerts`);
  mail = new MockEmailProvider();
});

const run = (now: Date, databaseLimitBytes = 10 * 1024 ** 4) =>
  protectionAlerts({
    transaction: (work) => db.transaction((tx) => work(tx as unknown as QueryRunner)),
    email: () => mail,
    clock: () => now,
    desk: () => DESK,
    databaseLimitBytes,
  });

/** Unpaid holds, two hours apart so none overlap, live for 35 minutes or already expired. */
let placed = 0;
async function holds(count: number, live = true): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    placed += 1;
    const start = new Date(Date.UTC(2031, 0, 1) + placed * 2 * 60 * 60_000);
    await db.query(
      `insert into slot_holds (slot_start, slot_end, expires_at, status) values ($1, $2, $3, 'held')`,
      [
        start,
        new Date(start.getTime() + 60 * 60_000),
        new Date(NOW.getTime() + (live ? 35 : -1) * 60_000),
      ],
    );
  }
}

describe("unpaid holds near the diary's cap", () => {
  it("are told to the desk once they reach the warning level", async () => {
    await holds(WARN_AT);
    const report = await run(NOW);
    expect(report).toMatchObject({ raised: 1, liveHolds: WARN_AT });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.to).toBe(DESK);
    expect(mail.sent[0]?.subject).toBe(
      `Unpaid holds are near the booking limit (${WARN_AT} of ${MAX_LIVE_HOLDS})`,
    );
  });

  it("stay quiet below it, and expired holds do not count", async () => {
    await holds(WARN_AT - 1);
    await holds(5, false);
    expect(await run(NOW)).toMatchObject({ raised: 0, liveHolds: WARN_AT - 1 });
    expect(mail.sent).toHaveLength(0);
  });

  it("are not emailed again within the day, and close quietly once the holds are gone", async () => {
    await holds(WARN_AT);
    await run(NOW);
    expect(await run(new Date(NOW.getTime() + 5 * 60_000))).toMatchObject({ raised: 0 });
    await db.query(`update slot_holds set status = 'expired'`);
    expect(await run(new Date(NOW.getTime() + 40 * 60_000))).toMatchObject({ resolved: 1 });
    expect(mail.sent).toHaveLength(1);
  });
});

/** End this many live holds, as their 35 minutes running out would. */
async function expire(count: number): Promise<void> {
  await db.query(
    `update slot_holds set status = 'expired'
      where id in (select id from slot_holds where status = 'held' limit $1)`,
    [count],
  );
}

describe("holds hovering at the warning line", () => {
  it("keep one alert open, with no new email, until they fall to half the cap", async () => {
    const clearAt = Math.ceil(MAX_LIVE_HOLDS * HOLDS_CLEAR_SHARE);
    await holds(WARN_AT);
    expect(await run(NOW)).toMatchObject({ raised: 1 });

    // One below the line: still open, nothing sent, nothing closed.
    await expire(1);
    expect(await run(new Date(NOW.getTime() + 5 * 60_000))).toMatchObject({
      raised: 0,
      resolved: 0,
    });

    // Back on the line: the same alert, still no new email.
    await holds(1);
    expect(await run(new Date(NOW.getTime() + 10 * 60_000))).toMatchObject({
      raised: 0,
      resolved: 0,
    });

    // Down to below half the cap: closed quietly.
    await expire(WARN_AT - clearAt + 1);
    expect(await run(new Date(NOW.getTime() + 15 * 60_000))).toMatchObject({ resolved: 1 });
    expect(mail.sent).toHaveLength(1);
  });
});

describe("the database near its plan's limit", () => {
  it("is told to the desk with how full it is", async () => {
    // A limit just above today's size puts it past the warning share.
    const size = Number(
      (
        await db.query<{ bytes: string }>(
          `select pg_database_size(current_database())::text as bytes`,
        )
      ).rows[0]?.bytes,
    );
    expect(size).toBeGreaterThan(0);
    const report = await run(NOW, Math.ceil(size / 0.9));
    expect(report).toMatchObject({ raised: 1 });
    expect(mail.sent[0]?.subject).toMatch(
      /^The booking database is nearly full \(\d+ MB of \d+ MB\)$/,
    );
  });

  it("stays quiet with room to spare", async () => {
    expect(await run(NOW)).toMatchObject({ raised: 0 });
    expect(mail.sent).toHaveLength(0);
  });
});

describe("a failure", () => {
  it("is reported, never thrown, so the rest of the sweep still runs", async () => {
    const report = await protectionAlerts({
      transaction: () => Promise.reject(new Error("database down")),
      email: () => mail,
      clock: () => NOW,
      desk: () => DESK,
    });
    expect(report).toEqual({ error: "protection alerts could not be checked" });
  });
});
