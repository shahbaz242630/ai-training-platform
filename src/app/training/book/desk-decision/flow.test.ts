import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryRunner } from "@/data/db";
import { recordWithdrawal } from "@/data/withdrawals";
import { createDeclineToken } from "@/lib/desk-link";
import { createManageToken } from "@/lib/manage-link";
import { LINK_NOT_VALID, confirmDecline, loadDeskDecision, type DeskDeps } from "./flow";

/**
 * The desk declining a withdrawal from its alert's link: looking changes
 * nothing, the press records the decision once, and only a valid desk link
 * for a desk notice can do either.
 */

let db: PGlite;
let runner: QueryRunner;
let n = 0;
const SECRET = "a-test-secret-that-is-long-enough-000000";
const NOW = new Date("2026-10-19T12:00:00Z");
const LATER = new Date("2026-11-03T12:00:00Z");

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

const deps = (now = NOW): DeskDeps => ({
  now,
  secret: SECRET,
  transaction: (work) => db.transaction((tx) => work(tx as unknown as QueryRunner)),
});

async function noticed(route: "automatic" | "desk"): Promise<string> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`desk-flow${n}@example.com`],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid') returning id`,
    [customer.rows[0]!.id],
  );
  const start = new Date(Date.UTC(2026, 11, 1, 10) + n * 3 * 60 * 60_000);
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end,
                           customer_timezone)
     values ($1, 'claude-claude-code', 1, 'confirmed', $2, $3, 'Asia/Dubai') returning id`,
    [order.rows[0]!.id, start, new Date(start.getTime() + 90 * 60_000)],
  );
  const bookingId = booking.rows[0]!.id;
  await recordWithdrawal(runner, {
    bookingId,
    fullName: "Amina Khan",
    email: `desk-flow${n}@example.com`,
    statement: "I, Amina Khan, withdraw from my contract.",
    refundDueFils: 149900,
    receivedAt: NOW,
    ipAddress: null,
    userAgent: null,
    route,
    cardCountry: route === "desk" ? "AE" : "GB",
  });
  return bookingId;
}

const tokenFor = (bookingId: string) => createDeclineToken({ bookingId, expiresAt: LATER }, SECRET);

const decisions = async (bookingId: string) =>
  (await db.query(`select 1 from withdrawal_decisions where booking_id = $1`, [bookingId])).rows
    .length;

describe("opening the link", () => {
  it("shows the notice and offers the decision, writing nothing", async () => {
    const bookingId = await noticed("desk");
    const result = await loadDeskDecision(tokenFor(bookingId), deps());
    expect(result).toMatchObject({
      ok: true,
      view: { amount: "AED 1,499", cardCountry: "AE", state: "open" },
    });
    expect(await decisions(bookingId)).toBe(0);
  });

  it("refuses a manage link, an expired link and a notice refunded automatically", async () => {
    const desk = await noticed("desk");
    const manage = createManageToken({ bookingId: desk, expiresAt: LATER }, SECRET);
    expect(await loadDeskDecision(manage, deps())).toEqual({ ok: false, message: LINK_NOT_VALID });
    expect(await loadDeskDecision(tokenFor(desk), deps(LATER))).toEqual({
      ok: false,
      message: LINK_NOT_VALID,
    });
    const auto = await noticed("automatic");
    expect(await loadDeskDecision(tokenFor(auto), deps())).toEqual({
      ok: false,
      message: LINK_NOT_VALID,
    });
  });
});

describe("a notice whose session has started", () => {
  it("says so, so the page does not promise a refund will cancel it", async () => {
    const bookingId = await noticed("desk");
    const start = (
      await db.query<{ scheduled_start: Date }>(
        `select scheduled_start from bookings where id = $1`,
        [bookingId],
      )
    ).rows[0]!.scheduled_start;
    const before = await loadDeskDecision(tokenFor(bookingId), deps());
    const after = await loadDeskDecision(
      createDeclineToken({ bookingId, expiresAt: new Date(start.getTime() + 86_400_000) }, SECRET),
      deps(new Date(start.getTime() + 60_000)),
    );
    expect(before).toMatchObject({ ok: true, view: { sessionStarted: false } });
    expect(after).toMatchObject({ ok: true, view: { sessionStarted: true } });
  });
});

describe("pressing decline", () => {
  it("records the decline once; the booking stays", async () => {
    const bookingId = await noticed("desk");
    const first = await confirmDecline(tokenFor(bookingId), deps());
    expect(first).toMatchObject({ ok: true, newlyDeclined: true, view: { state: "declined" } });
    const again = await confirmDecline(tokenFor(bookingId), deps());
    expect(again).toMatchObject({ ok: true, newlyDeclined: false, view: { state: "declined" } });
    expect(await decisions(bookingId)).toBe(1);
    const booking = await db.query<{ status: string }>(
      `select status from bookings where id = $1`,
      [bookingId],
    );
    expect(booking.rows[0]?.status).toBe("confirmed");
  });

  it("says a refunded notice was approved, and records no decline for it", async () => {
    const bookingId = await noticed("desk");
    await db.query(
      `update orders set payment_status = 'refunded'
        where id = (select order_id from bookings where id = $1)`,
      [bookingId],
    );
    const result = await confirmDecline(tokenFor(bookingId), deps());
    expect(result).toMatchObject({ ok: true, newlyDeclined: false, view: { state: "refunded" } });
    expect(await decisions(bookingId)).toBe(0);
  });

  it("refuses anything that is not a desk link", async () => {
    expect(await confirmDecline(42, deps())).toEqual({ ok: false, message: LINK_NOT_VALID });
    expect(await confirmDecline("d1.x.y.z", deps())).toEqual({
      ok: false,
      message: LINK_NOT_VALID,
    });
  });
});
