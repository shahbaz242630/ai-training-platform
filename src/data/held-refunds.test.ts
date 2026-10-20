import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import { applyHeldRefunds, holdRefundEvent } from "./held-refunds";
import { purgeExpiredPersonalData } from "./retention";
import { applyCheckoutOutcome } from "@/app/api/webhooks/stripe/checkout-outcome";
import type { RefundEvent, RefundStatus } from "@/domain/payments/provider";

/**
 * A refund that overtakes its payment (audit s104 PAY-2). After an outage
 * Stripe can deliver a dashboard refund before the payment that it refunds;
 * it was dropped, and settlement then confirmed a session for money already
 * given back. Now it is held and applied at settlement, as if it had arrived
 * then.
 */

let db: PGlite;
let n = 0;
const NOW = new Date("2027-03-01T12:00:00Z");

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

const tx = <T>(work: (r: QueryRunner) => Promise<T>) =>
  db.transaction((t) => work(t as unknown as QueryRunner));

/** A pending order with its checkout session and a booking waiting for payment. */
async function pendingOrder(): Promise<{ orderId: string; bookingId: string; session: string }> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`held${n}@example.com`],
  );
  const session = `cs_held_${n}`;
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_checkout_session_id)
     values ($1, 'single', 'ai-foundations', 129900, 'pending', $2) returning id`,
    [customer.rows[0]!.id, session],
  );
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, customer_timezone)
     values ($1, 'ai-foundations', 1, 'awaiting_schedule', 'Asia/Dubai') returning id`,
    [order.rows[0]!.id],
  );
  return { orderId: order.rows[0]!.id, bookingId: booking.rows[0]!.id, session };
}

const refund = (
  intent: string,
  status: RefundStatus,
  at: Date,
  amountFils = 129900,
  id = `re_held_${intent}`,
): RefundEvent => ({
  kind: "refund",
  eventId: `evt_${id}_${status}`,
  type: "refund.updated",
  occurredAt: at,
  ignorable: false,
  orderId: null,
  refundRowId: null,
  providerRefundId: id,
  paymentIntentId: intent,
  amountFils,
  currency: "AED",
  status,
});

const settle = (orderId: string, session: string, intent: string) =>
  tx((r) =>
    applyCheckoutOutcome(
      r,
      {
        checkoutSessionId: session,
        paymentIntentId: intent,
        orderId,
        slotHoldId: null,
        outcome: "paid",
        amountFils: 129900,
        currency: "AED",
      },
      NOW,
    ),
  );

const state = async (orderId: string, bookingId: string) => ({
  order: (
    await db.query<{ payment_status: string }>(`select payment_status from orders where id = $1`, [
      orderId,
    ])
  ).rows[0]?.payment_status,
  booking: (
    await db.query<{ status: string }>(`select status from bookings where id = $1`, [bookingId])
  ).rows[0]?.status,
  held: (
    await db.query(`select 1 from held_refund_events where payment_intent_id = $1`, [
      `pi_${orderId}`,
    ])
  ).rows.length,
});

describe("a refund that arrives before its payment", () => {
  it("is applied when the payment settles: refunded in full, no session confirmed", async () => {
    const o = await pendingOrder();
    const intent = `pi_${o.orderId}`;
    await tx((r) => holdRefundEvent(r, refund(intent, "succeeded", NOW), NOW));
    expect((await state(o.orderId, o.bookingId)).held).toBe(1);

    expect(await settle(o.orderId, o.session, intent)).toBe("paid_without_slot");

    expect(await state(o.orderId, o.bookingId)).toEqual({
      order: "refunded",
      booking: "cancelled",
      held: 0,
    });
    const rows = await db.query<{ origin: string; status: string }>(
      `select origin, status from refunds where order_id = $1`,
      [o.orderId],
    );
    expect(rows.rows).toEqual([{ origin: "processor", status: "succeeded" }]);
  });

  it("keeps the newest event: a late 'pending' does not undo a 'succeeded'", async () => {
    const o = await pendingOrder();
    const intent = `pi_${o.orderId}`;
    await tx((r) => holdRefundEvent(r, refund(intent, "succeeded", NOW), NOW));
    await tx((r) =>
      holdRefundEvent(r, refund(intent, "pending", new Date(NOW.getTime() - 60_000)), NOW),
    );
    await settle(o.orderId, o.session, intent);
    expect((await state(o.orderId, o.bookingId)).order).toBe("refunded");
  });

  it("lets a final status win a tie: a pending in the same second does not undo succeeded", async () => {
    const o = await pendingOrder();
    const intent = "pi_" + o.orderId;
    await tx((r) => holdRefundEvent(r, refund(intent, "succeeded", NOW), NOW));
    await tx((r) => holdRefundEvent(r, refund(intent, "pending", NOW), NOW));
    await settle(o.orderId, o.session, intent);
    expect((await state(o.orderId, o.bookingId)).order).toBe("refunded");
  });

  it("leaves a part refund as a goodwill gesture: the booking stays", async () => {
    const o = await pendingOrder();
    const intent = `pi_${o.orderId}`;
    await tx((r) => holdRefundEvent(r, refund(intent, "succeeded", NOW, 20000), NOW));
    await settle(o.orderId, o.session, intent);
    expect(await state(o.orderId, o.bookingId)).toEqual({
      order: "partially_refunded",
      booking: "awaiting_schedule",
      held: 0,
    });
  });

  it("is deleted after a year if no payment of ours ever names it", async () => {
    await tx((r) =>
      holdRefundEvent(r, refund("pi_never", "succeeded", NOW), new Date("2025-01-01T00:00:00Z")),
    );
    await tx((r) => purgeExpiredPersonalData(r, NOW));
    const left = await db.query(`select 1 from held_refund_events where payment_intent_id = $1`, [
      "pi_never",
    ]);
    expect(left.rows).toHaveLength(0);
  });
});

describe("nothing to hold or apply", () => {
  it("holds no refund without a payment, or with no amount", async () => {
    expect(
      await tx((r) =>
        holdRefundEvent(r, { ...refund("pi_x", "succeeded", NOW), paymentIntentId: null }, NOW),
      ),
    ).toBe(false);
    expect(
      await tx((r) => holdRefundEvent(r, refund("pi_zero", "succeeded", NOW, 0, "re_zero"), NOW)),
    ).toBe(false);
  });

  it("applies nothing for a settlement with no payment, or none held", async () => {
    expect(await tx((r) => applyHeldRefunds(r, null, NOW))).toEqual([]);
    expect(await tx((r) => applyHeldRefunds(r, "pi_nothing_held", NOW))).toEqual([]);
  });
});
