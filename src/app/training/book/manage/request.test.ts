import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QueryRunner } from "@/data/db";
import { bookingReference } from "@/domain/booking/withdrawal";
import type { EmailMessage } from "@/domain/messaging/provider";
import { readManageToken } from "@/lib/manage-link";
import { addDays, addMinutes } from "@/lib/time";
import {
  LINK_MINUTES,
  parseManageRequest,
  sendManageLinks,
  type ManageRequestDeps,
} from "./request";

/** "Manage my booking" by email address: what is sent, to whom, and what never is. */

// A plain run of one letter: long enough for the 32-character minimum, never mistaken for a key.
const SECRET = "x".repeat(40);
const NOW = new Date("2027-06-01T08:00:00.000Z");

let db: PGlite;
let runner: QueryRunner;
let n = 0;

beforeAll(async () => {
  db = await PGlite.create();
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  runner = db as unknown as QueryRunner;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

async function bookedCustomer() {
  n += 1;
  const email = `manage-request${n}@example.com`;
  const c = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [email],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid') returning id`,
    [c.rows[0]!.id],
  );
  const start = addDays(NOW, n * 3);
  const b = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start,
                           scheduled_end, customer_timezone)
     values ($1, 'claude-claude-code', 1, 'confirmed', $2, $3, 'Asia/Dubai') returning id`,
    [order.rows[0]!.id, start, addMinutes(start, 90)],
  );
  return { email, bookingId: b.rows[0]!.id };
}

function deps(): ManageRequestDeps & { sent: EmailMessage[]; asked: string[] } {
  const sent: EmailMessage[] = [];
  const asked: string[] = [];
  return {
    transaction: (work) => work(runner),
    now: NOW,
    secret: SECRET,
    siteUrl: "https://coaching.example",
    send: (message) => {
      sent.push(message);
      return Promise.resolve({ ok: true, providerMessageId: "m" });
    },
    mayEmail: (email) => {
      asked.push(email);
      return true;
    },
    sent,
    asked,
  };
}

describe("parseManageRequest", () => {
  it("takes an email and an optional reference, normalised", () => {
    expect(parseManageRequest({ email: " Amina@Example.com ", reference: "" })).toEqual({
      ok: true,
      request: { email: "amina@example.com", reference: null },
    });
    expect(parseManageRequest({ email: "a@example.com", reference: "3f9a-1c2b" })).toMatchObject({
      ok: true,
      request: { reference: "3F9A1C2B" },
    });
  });

  it("refuses a malformed address or reference, and anything extra", () => {
    expect(parseManageRequest({ email: "not-an-email", reference: "" }).ok).toBe(false);
    expect(parseManageRequest({ email: "a@example.com", reference: "nope" }).ok).toBe(false);
    expect(parseManageRequest({ email: "a@example.com", reference: "", bookingId: "x" }).ok).toBe(
      false,
    );
  });
});

describe("sendManageLinks", () => {
  it("emails the address a one-hour link to its upcoming booking", async () => {
    const c = await bookedCustomer();
    const d = deps();

    expect(await sendManageLinks({ email: c.email, reference: null }, d)).toBe("sent");

    expect(d.sent).toHaveLength(1);
    expect(d.sent[0]?.to).toBe(c.email);
    expect(d.sent[0]?.text).toContain(bookingReference(c.bookingId));
    const token = /manage\?t=([A-Za-z0-9._-]+)/.exec(d.sent[0]?.html ?? "")?.[1] ?? "";
    expect(readManageToken(token, NOW, SECRET)).toBe(c.bookingId);
    // Gone after the hour.
    expect(readManageToken(token, addMinutes(NOW, LINK_MINUTES), SECRET)).toBeNull();
  });

  it("sends nothing at all for an address with no upcoming booking", async () => {
    const d = deps();
    expect(await sendManageLinks({ email: "nobody@example.com", reference: null }, d)).toBe(
      "nothing_found",
    );
    expect(d.sent).toEqual([]);
  });

  it("sends nothing when the reference belongs to someone else", async () => {
    const theirs = await bookedCustomer();
    const mine = await bookedCustomer();
    const d = deps();

    expect(
      await sendManageLinks(
        { email: mine.email, reference: bookingReference(theirs.bookingId) },
        d,
      ),
    ).toBe("nothing_found");
    expect(d.sent).toEqual([]);
  });

  it("reports a failed send so it can be logged", async () => {
    const c = await bookedCustomer();
    const d = {
      ...deps(),
      send: () =>
        Promise.resolve({ ok: false as const, code: "x", message: "no", retryable: true }),
    };
    expect(await sendManageLinks({ email: c.email, reference: null }, d)).toBe("not_sent");
  });

  it("asks the inbox limit only when there is something to send, and respects it", async () => {
    const nobody = deps();
    await sendManageLinks({ email: "nobody-else@example.com", reference: null }, nobody);
    // A request that finds nothing never counts against the address.
    expect(nobody.asked).toEqual([]);

    const c = await bookedCustomer();
    const limited = { ...deps(), mayEmail: () => false };
    expect(await sendManageLinks({ email: c.email, reference: null }, limited)).toBe("inbox_limit");
    expect(limited.sent).toEqual([]);
  });

  it("sends nothing for a booking that is not paid for", async () => {
    const c = await bookedCustomer();
    await db.query(
      "update orders set payment_status = 'pending' where id = (select order_id from bookings where id = $1)",
      [c.bookingId],
    );
    const d = deps();
    expect(await sendManageLinks({ email: c.email, reference: null }, d)).toBe("nothing_found");
  });
});
