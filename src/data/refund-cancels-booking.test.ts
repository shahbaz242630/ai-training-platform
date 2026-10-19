import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import { issueDueRefunds } from "./refund-issuer";
import { applyRefundEvent } from "./refunds";
import { recordWithdrawal } from "./withdrawals";
import { MockPaymentProvider } from "@/domain/payments/mock-provider";
import type { RefundEvent } from "@/domain/payments/provider";

/**
 * A full refund made anywhere, the payment dashboard included, ends the
 * booking it paid for: cancelled, its time back on sale, its reminders
 * stopped. This is how the desk approves a withdrawal it decided, and it
 * closes the gap where a dashboard refund left a session booked, reminded
 * and blocking the diary for money already returned.
 */

let db: PGlite;
let runner: QueryRunner;
let n = 0;
const NOW = new Date("2026-10-19T12:00:00Z");

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

/** A paid, confirmed booking with its converted hold and a reminder queued. */
async function booked(): Promise<{
  orderId: string;
  bookingId: string;
  holdId: string;
  intent: string;
}> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`refund-cancel${n}@example.com`],
  );
  const intent = `pi_cancel_${n}`;
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_payment_intent_id)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid', $2) returning id`,
    [customer.rows[0]!.id, intent],
  );
  const orderId = order.rows[0]!.id;
  const start = new Date(Date.UTC(2026, 11, 1, 10) + n * 3 * 60 * 60_000);
  const end = new Date(start.getTime() + 90 * 60_000);
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end,
                           customer_timezone)
     values ($1, 'claude-claude-code', 1, 'confirmed', $2, $3, 'Asia/Dubai') returning id`,
    [orderId, start, end],
  );
  const hold = await db.query<{ id: string }>(
    `insert into slot_holds (slot_start, slot_end, order_id, expires_at, status)
     values ($1, $2, $3, $1, 'converted') returning id`,
    [start, end, orderId],
  );
  const bookingId = booking.rows[0]!.id;
  for (const templateKey of ["reminder_24h", "withdrawal_acknowledgement"]) {
    await db.query(
      `insert into communication_log (booking_id, channel, template_key, status, scheduled_for)
       values ($1, 'email', $2, 'queued', now() + interval '1 day')`,
      [bookingId, templateKey],
    );
  }
  return { orderId, bookingId, holdId: hold.rows[0]!.id, intent };
}

const dashboardRefund = (intent: string, amountFils = 149900): RefundEvent => ({
  kind: "refund",
  eventId: `evt_cancel_${++n}`,
  type: "refund.created",
  occurredAt: NOW,
  ignorable: false,
  orderId: null,
  refundRowId: null,
  providerRefundId: `re_cancel_${n}`,
  paymentIntentId: intent,
  amountFils,
  currency: "AED",
  status: "succeeded",
});

const one = async <T extends Record<string, unknown>>(sql: string, id: string) =>
  (await db.query<T>(sql, [id])).rows[0];

describe("a full refund made in the dashboard", () => {
  it("cancels the booking, frees its time and stops its reminders", async () => {
    const b = await booked();
    const outcome = await applyRefundEvent(runner, dashboardRefund(b.intent), NOW);
    expect(outcome).toMatchObject({ orderMove: "refunded", cancelledBookings: [b.bookingId] });

    expect(await one(`select status from bookings where id = $1`, b.bookingId)).toEqual({
      status: "cancelled",
    });
    expect(await one(`select status from slot_holds where id = $1`, b.holdId)).toEqual({
      status: "released",
    });
    expect(
      await one(
        `select status from communication_log
          where booking_id = $1 and template_key = 'reminder_24h'`,
        b.bookingId,
      ),
    ).toEqual({ status: "cancelled" });
  });

  it("queues the email telling the customer it is cancelled and refunded", async () => {
    const b = await booked();
    await applyRefundEvent(runner, dashboardRefund(b.intent), NOW);
    expect(
      await one(
        `select status from communication_log
          where booking_id = $1 and template_key = 'cancellation_confirmation'`,
        b.bookingId,
      ),
    ).toEqual({ status: "queued" });
  });

  it("keeps the withdrawal acknowledgement queued: it is owed after the cancellation too", async () => {
    const b = await booked();
    await applyRefundEvent(runner, dashboardRefund(b.intent), NOW);
    expect(
      await one(
        `select status from communication_log
          where booking_id = $1 and template_key = 'withdrawal_acknowledgement'`,
        b.bookingId,
      ),
    ).toEqual({ status: "queued" });
  });

  it("does it once: the same refund again cancels nothing more", async () => {
    const b = await booked();
    const event = dashboardRefund(b.intent);
    await applyRefundEvent(runner, event, NOW);
    const again = await applyRefundEvent(runner, { ...event, eventId: "evt_again" }, NOW);
    expect(again.cancelledBookings).toEqual([]);
  });
});

describe("a full refund after the session", () => {
  it("leaves a session that already took place as it was", async () => {
    const b = await booked();
    const start = await one<{ scheduled_start: Date }>(
      `select scheduled_start from bookings where id = $1`,
      b.bookingId,
    );
    const after = new Date(start!.scheduled_start.getTime() + 2 * 60 * 60_000);
    const outcome = await applyRefundEvent(runner, dashboardRefund(b.intent), after);
    expect(outcome).toMatchObject({ orderMove: "refunded", cancelledBookings: [] });
    expect(await one(`select status from bookings where id = $1`, b.bookingId)).toEqual({
      status: "confirmed",
    });
    expect(await one(`select status from slot_holds where id = $1`, b.holdId)).toEqual({
      status: "converted",
    });
  });
});

describe("a part refund", () => {
  it("leaves the booking, its time and its reminders as they are", async () => {
    const b = await booked();
    const outcome = await applyRefundEvent(runner, dashboardRefund(b.intent, 50000), NOW);
    expect(outcome).toMatchObject({ orderMove: "partially_refunded", cancelledBookings: [] });
    expect(
      await one(
        `select count(*)::int as n from communication_log
          where booking_id = $1 and template_key = 'cancellation_confirmation'`,
        b.bookingId,
      ),
    ).toEqual({ n: 0 });
    expect(await one(`select status from bookings where id = $1`, b.bookingId)).toEqual({
      status: "confirmed",
    });
    expect(await one(`select status from slot_holds where id = $1`, b.holdId)).toEqual({
      status: "converted",
    });
  });
});

describe("a refund the sweep makes itself", () => {
  const transaction = <T>(work: (r: QueryRunner) => Promise<T>) =>
    db.transaction((tx) => work(tx as unknown as QueryRunner));
  const templates = async (bookingId: string) =>
    (
      await db.query<{ template_key: string }>(
        `select template_key from communication_log where booking_id = $1 order by template_key`,
        [bookingId],
      )
    ).rows.map((r) => r.template_key);

  it("cancels a booking still open when it completes the order, and tells the customer", async () => {
    const b = await booked();
    // A withdrawal refund owed while the booking is still open: the state the rule guards.
    const notice = await db.query<{ id: string }>(
      `insert into withdrawal_requests (booking_id, full_name, email, statement, refund_due_fils, received_at)
       values ($1, 'Amina Khan', 'x@example.com', 'I withdraw.', 149900, $2) returning id`,
      [b.bookingId, NOW],
    );
    await db.query(
      `insert into refunds (order_id, withdrawal_request_id, origin, amount_fils, currency, status,
                            created_at, updated_at)
       values ($1, $2, 'withdrawal', 149900, 'AED', 'due', $3, $3)`,
      [b.orderId, notice.rows[0]!.id, NOW],
    );
    const provider = new MockPaymentProvider();
    provider.refundStatus = "succeeded";
    await issueDueRefunds({ provider, transaction, clock: () => NOW });

    expect(await one(`select status from bookings where id = $1`, b.bookingId)).toEqual({
      status: "cancelled",
    });
    expect(await templates(b.bookingId)).toContain("cancellation_confirmation");
  });

  it("sends no cancellation email after an automatic withdrawal: that booking was already cancelled", async () => {
    const b = await booked();
    await recordWithdrawal(runner, {
      bookingId: b.bookingId,
      fullName: "Amina Khan",
      email: "x@example.com",
      statement: "I withdraw.",
      refundDueFils: 149900,
      receivedAt: NOW,
      ipAddress: null,
      userAgent: null,
      route: "automatic",
      cardCountry: "GB",
    });
    const provider = new MockPaymentProvider();
    provider.refundStatus = "succeeded";
    await issueDueRefunds({ provider, transaction, clock: () => NOW });

    const sent = await templates(b.bookingId);
    expect(sent).toContain("refund_issued");
    expect(sent).not.toContain("cancellation_confirmation");
  });
});
