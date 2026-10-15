import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import { applyRefundEvent, claimDueRefunds, closeRefund, createWithdrawalRefund } from "./refunds";
import {
  countRefundsNeedingAttention,
  listPendingRefundsToRefresh,
  listRefundsNeedingAttention,
  markRefundChecked,
  refundStateForEmail,
  refundWorkWaiting,
} from "./refund-queries";
import { bookingReference } from "@/domain/booking/withdrawal";
import type { RefundEvent } from "@/domain/payments/provider";

/**
 * The read side of refunds: what the alarm and the desk alerts count, what
 * the sweep has to do next, and what a customer's email may say about their
 * money. One source for each, so the alarm, the email and the sweep agree.
 */

let db: PGlite;
let runner: QueryRunner;
let n = 0;
const NOW = new Date("2026-10-15T12:00:00Z");
const MIN = 60_000;
const later = (minutes: number) => new Date(NOW.getTime() + minutes * MIN);

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

interface Seeded {
  readonly orderId: string;
  readonly bookingId: string;
  readonly noticeId: string;
  readonly intent: string;
}

/** A paid, withdrawn order with its notice. */
async function seed(
  over: { paymentStatus?: string; intent?: string | null } = {},
): Promise<Seeded> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Europe/London') returning id`,
    [`refund${n}@example.com`],
  );
  const intent = over.intent === undefined ? `pi_${n}` : over.intent;
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_payment_intent_id)
     values ($1, 'single', 'claude-claude-code', 149900, $2, $3) returning id`,
    [customer.rows[0]!.id, over.paymentStatus ?? "paid", intent],
  );
  const orderId = order.rows[0]!.id;
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, customer_timezone)
     values ($1, 'claude-claude-code', 1, 'cancelled', 'Europe/London') returning id`,
    [orderId],
  );
  const notice = await db.query<{ id: string }>(
    `insert into withdrawal_requests (booking_id, full_name, email, statement, refund_due_fils, received_at)
     values ($1, 'Amina Khan', $2, 'I withdraw.', 149900, $3) returning id`,
    [booking.rows[0]!.id, `refund${n}@example.com`, NOW],
  );
  return {
    orderId,
    bookingId: booking.rows[0]!.id,
    noticeId: notice.rows[0]!.id,
    intent: intent ?? "",
  };
}

async function owed(s: Seeded): Promise<string> {
  return createWithdrawalRefund(runner, {
    orderId: s.orderId,
    withdrawalRequestId: s.noticeId,
    amountFils: 149900,
    now: NOW,
  });
}

async function orderStatus(orderId: string): Promise<string> {
  const result = await db.query<{ payment_status: string }>(
    `select payment_status from orders where id = $1`,
    [orderId],
  );
  return result.rows[0]!.payment_status;
}

const event = (over: Partial<RefundEvent> = {}): RefundEvent => ({
  kind: "refund",
  eventId: `evt_${++n}`,
  type: "refund.updated",
  occurredAt: NOW,
  ignorable: false,
  orderId: null,
  refundRowId: null,
  providerRefundId: `re_${n}`,
  paymentIntentId: null,
  amountFils: 149900,
  currency: "AED",
  status: "succeeded",
  ...over,
});

async function order(): Promise<{ orderId: string; bookingId: string; intent: string }> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Europe/London') returning id`,
    [`attention${n}@example.com`],
  );
  const intent = `pi_attention_${n}`;
  const o = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_payment_intent_id)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid', $2) returning id`,
    [customer.rows[0]!.id, intent],
  );
  const b = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, customer_timezone)
     values ($1, 'claude-claude-code', 1, 'cancelled', 'Europe/London') returning id`,
    [o.rows[0]!.id],
  );
  return { orderId: o.rows[0]!.id, bookingId: b.rows[0]!.id, intent };
}

async function withdrawalRefund(status: string, lastError: string | null) {
  const o = await order();
  const notice = await db.query<{ id: string }>(
    `insert into withdrawal_requests (booking_id, full_name, email, statement, refund_due_fils, received_at)
     values ($1, 'Amina Khan', $2, 'I withdraw.', 149900, $3) returning id`,
    [o.bookingId, `attention${n}@example.com`, NOW],
  );
  const r = await db.query<{ id: string }>(
    `insert into refunds (order_id, withdrawal_request_id, origin, amount_fils, currency, status,
                          last_error, created_at, updated_at)
     values ($1, $2, 'withdrawal', 149900, 'AED', $3, $4, $5, $5) returning id`,
    [o.orderId, notice.rows[0]!.id, status, lastError, NOW],
  );
  return { ...o, refundId: r.rows[0]!.id };
}

describe("listRefundsNeedingAttention", () => {
  beforeEach(async () => {
    await db.query(`delete from refunds`);
  });

  it("gives what the desk needs to find the payment, and nothing about the customer", async () => {
    const r = await withdrawalRefund("failed", "charge_already_refunded");
    const listed = await listRefundsNeedingAttention(runner, NOW);
    expect(listed).toEqual([
      {
        refundId: r.refundId,
        bookingReference: bookingReference(r.bookingId),
        amountFils: 149900,
        currency: "AED",
        status: "failed",
        lastError: "charge_already_refunded",
        paymentIntentId: r.intent,
      },
    ]);
  });

  it("names the order's booking for a refund made in the dashboard", async () => {
    const o = await order();
    await db.query(
      `insert into refunds (order_id, origin, amount_fils, currency, status, provider_refund_id,
                            created_at, updated_at)
       values ($1, 'processor', 149900, 'AED', 'failed', 're_dash_fail', $2, $2)`,
      [o.orderId, NOW],
    );
    const [listed] = await listRefundsNeedingAttention(runner, NOW);
    expect(listed?.bookingReference).toBe(bookingReference(o.bookingId));
  });

  it("is what the count counts", async () => {
    await withdrawalRefund("failed", "no_payment_intent");
    await withdrawalRefund("succeeded", null);
    const listed = await listRefundsNeedingAttention(runner, NOW);
    expect(listed).toHaveLength(1);
    expect(await countRefundsNeedingAttention(runner, NOW)).toBe(1);
  });
});

describe("countRefundsNeedingAttention", () => {
  it("counts a failed refund the money has not been covered for, until it is", async () => {
    const before = await countRefundsNeedingAttention(runner, NOW);
    const s = await seed();
    const id = await owed(s);
    await db.query(`update refunds set status = 'issuing' where id = $1`, [id]);
    await closeRefund(runner, id, "failed", "no_payment_intent", NOW);
    expect(await countRefundsNeedingAttention(runner, NOW)).toBe(before + 1);

    // Somebody refunds it by hand in the dashboard: the alarm stops.
    await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_byhand", paymentIntentId: s.intent }),
      NOW,
    );
    expect(await countRefundsNeedingAttention(runner, NOW)).toBe(before);
  });

  it("still counts a success that later failed, even though the order says refunded", async () => {
    const before = await countRefundsNeedingAttention(runner, NOW);
    const s = await seed();
    await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_flip", paymentIntentId: s.intent, status: "succeeded" }),
      NOW,
    );
    await applyRefundEvent(
      runner,
      event({
        providerRefundId: "re_flip",
        paymentIntentId: s.intent,
        status: "failed",
        occurredAt: later(1),
      }),
      NOW,
    );
    expect(await orderStatus(s.orderId)).toBe("refunded");
    expect(await countRefundsNeedingAttention(runner, NOW)).toBe(before + 1);
  });

  it("counts a refund still owed a day later, and one pending for days", async () => {
    const before = await countRefundsNeedingAttention(runner, later(60 * 24 * 4));
    const s = await seed();
    await owed(s);
    const t = await seed();
    await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_slow", paymentIntentId: t.intent, status: "pending" }),
      NOW,
    );
    const after = await countRefundsNeedingAttention(runner, later(60 * 24 * 4));
    expect(after).toBe(before + 2);
  });
});

describe("listPendingRefundsToRefresh", () => {
  it("does not list a refund asked about within the hour", async () => {
    const s = await seed();
    await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_asked", paymentIntentId: s.intent, status: "pending" }),
      NOW,
    );
    const asked = await db.query<{ id: string }>(
      `select id from refunds where provider_refund_id = 're_asked'`,
    );
    await markRefundChecked(runner, asked.rows[0]!.id, later(90));
    const listed = async (at: Date) =>
      (await listPendingRefundsToRefresh(runner, at, 50)).map((r) => r.providerRefundId);
    expect(await listed(later(120))).not.toContain("re_asked");
    expect(await listed(later(151))).toContain("re_asked");
  });

  it("lists refunds Stripe has said nothing more about for an hour", async () => {
    const s = await seed();
    await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_quiet", paymentIntentId: s.intent, status: "pending" }),
      NOW,
    );
    expect(
      (await listPendingRefundsToRefresh(runner, later(30), 50)).map((r) => r.providerRefundId),
    ).not.toContain("re_quiet");
    expect(
      (await listPendingRefundsToRefresh(runner, later(61), 50)).map((r) => r.providerRefundId),
    ).toContain("re_quiet");
  });
});

describe("refundStateForEmail", () => {
  it("says refunded only once the refund succeeded", () => {
    expect(refundStateForEmail({ status: "succeeded", providerRefundId: "re_1" })).toBe(
      "succeeded",
    );
  });

  it("says issued while Stripe has it and it is still on its way", () => {
    expect(refundStateForEmail({ status: "pending", providerRefundId: "re_1" })).toBe("issued");
  });

  it("says owed for everything else, including a failed refund and none at all", () => {
    for (const status of ["due", "issuing", "failed", "canceled", "superseded"] as const) {
      expect(refundStateForEmail({ status, providerRefundId: null })).toBe("owed");
    }
    expect(refundStateForEmail({ status: "failed", providerRefundId: "re_1" })).toBe("owed");
    expect(refundStateForEmail(null)).toBe("owed");
  });
});

describe("refundWorkWaiting", () => {
  it("is true while a refund is due, and false once nothing is", async () => {
    await db.query(
      `update refunds set status = 'superseded' where status in ('due', 'issuing', 'pending')`,
    );
    expect(await refundWorkWaiting(runner, NOW)).toBe(false);
    const s = await seed();
    const id = await owed(s);
    expect(await refundWorkWaiting(runner, NOW)).toBe(true);
    await claimDueRefunds(runner, NOW, 5);
    await closeRefund(runner, id, "superseded", null, NOW);
    expect(await refundWorkWaiting(runner, NOW)).toBe(false);
  });
});
