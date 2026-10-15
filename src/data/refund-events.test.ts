import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import { applyRefundEvent, createWithdrawalRefund } from "./refunds";
import type { RefundEvent } from "@/domain/payments/provider";

/**
 * What Stripe's refund events do to a refund row and its order, and the
 * alarm that keeps money owed in front of a person until it has gone back.
 * A mistake here is an order that says paid for money already returned, or
 * a failed refund nobody hears about.
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

async function row(id: string) {
  const result = await db.query<{
    status: string;
    attempts: number;
    key_seq: number;
    provider_refund_id: string | null;
    last_error: string | null;
    next_attempt_at: Date | null;
    origin: string;
    amount_fils: string;
  }>(`select * from refunds where id = $1`, [id]);
  return result.rows[0]!;
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

describe("applyRefundEvent", () => {
  it("settles our own refund, found by the row id in its metadata", async () => {
    const s = await seed();
    const id = await owed(s);
    const outcome = await applyRefundEvent(
      runner,
      event({
        orderId: s.orderId,
        refundRowId: id,
        providerRefundId: "re_ours",
        paymentIntentId: s.intent,
      }),
      NOW,
    );
    expect(outcome).toEqual({
      result: "applied",
      orderId: s.orderId,
      refundId: id,
      status: "succeeded",
      orderMove: "refunded",
    });
    expect(await row(id)).toMatchObject({ provider_refund_id: "re_ours", status: "succeeded" });
  });

  it("records a refund made in the dashboard, found by its payment", async () => {
    const s = await seed();
    const outcome = await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_dash", paymentIntentId: s.intent }),
      NOW,
    );
    expect(outcome.result).toBe("applied");
    expect(outcome.orderMove).toBe("refunded");
    const rows = await db.query<{ origin: string }>(
      `select origin from refunds where provider_refund_id = 're_dash'`,
    );
    expect(rows.rows).toEqual([{ origin: "processor" }]);
  });

  it("records a part refund as partly refunded, then refunded when the rest goes back", async () => {
    const s = await seed();
    const part = await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_part1", paymentIntentId: s.intent, amountFils: 50000 }),
      NOW,
    );
    expect(part.orderMove).toBe("partially_refunded");
    const rest = await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_part2", paymentIntentId: s.intent, amountFils: 99900 }),
      NOW,
    );
    expect(rest.orderMove).toBe("refunded");
    expect(await orderStatus(s.orderId)).toBe("refunded");
  });

  it("applies the same refund twice as one", async () => {
    const s = await seed();
    const e = event({ providerRefundId: "re_twice", paymentIntentId: s.intent, amountFils: 50000 });
    await applyRefundEvent(runner, e, NOW);
    await applyRefundEvent(runner, { ...e, eventId: "evt_other" }, NOW);
    const rows = await db.query(`select 1 from refunds where provider_refund_id = 're_twice'`);
    expect(rows.rows).toHaveLength(1);
    expect(await orderStatus(s.orderId)).toBe("partially_refunded");
  });

  it("never moves a refund backwards when an older event arrives late", async () => {
    const s = await seed();
    await applyRefundEvent(
      runner,
      event({
        providerRefundId: "re_late",
        paymentIntentId: s.intent,
        status: "succeeded",
        occurredAt: later(2),
      }),
      NOW,
    );
    const late = await applyRefundEvent(
      runner,
      event({
        providerRefundId: "re_late",
        paymentIntentId: s.intent,
        status: "pending",
        occurredAt: later(1),
      }),
      NOW,
    );
    expect(late.result).toBe("stale");
    const r = await db.query<{ status: string }>(
      `select status from refunds where provider_refund_id = 're_late'`,
    );
    expect(r.rows[0]?.status).toBe("succeeded");
  });

  it("lets a final status win over pending when both carry the same time", async () => {
    const s = await seed();
    await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_tie", paymentIntentId: s.intent, status: "succeeded" }),
      NOW,
    );
    await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_tie", paymentIntentId: s.intent, status: "pending" }),
      NOW,
    );
    const r = await db.query<{ status: string }>(
      `select status from refunds where provider_refund_id = 're_tie'`,
    );
    expect(r.rows[0]?.status).toBe("succeeded");
  });

  it("lets a later failure override a success", async () => {
    const s = await seed();
    await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_fail", paymentIntentId: s.intent, status: "succeeded" }),
      NOW,
    );
    await applyRefundEvent(
      runner,
      event({
        providerRefundId: "re_fail",
        paymentIntentId: s.intent,
        status: "failed",
        occurredAt: later(1),
      }),
      NOW,
    );
    const r = await db.query<{ status: string }>(
      `select status from refunds where provider_refund_id = 're_fail'`,
    );
    expect(r.rows[0]?.status).toBe("failed");
    // Refunded is final for the order; the alarm is what catches this.
    expect(await orderStatus(s.orderId)).toBe("refunded");
  });

  it("knows no order for a payment it has never seen", async () => {
    const outcome = await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_nowhere", paymentIntentId: "pi_never" }),
      NOW,
    );
    expect(outcome.result).toBe("unknown_order");
  });

  it("refuses a refund that names our order but a different payment", async () => {
    const s = await seed();
    const outcome = await applyRefundEvent(
      runner,
      event({
        orderId: s.orderId,
        providerRefundId: "re_wrong",
        paymentIntentId: "pi_somebody_else",
      }),
      NOW,
    );
    expect(outcome.result).toBe("mismatched");
    expect(await orderStatus(s.orderId)).toBe("paid");
  });

  it("refuses a refund in another currency", async () => {
    const s = await seed();
    const outcome = await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_usd", paymentIntentId: s.intent, currency: "USD" }),
      NOW,
    );
    expect(outcome.result).toBe("mismatched");
  });

  it("refuses a row id that belongs to another order", async () => {
    const a = await seed();
    const b = await seed();
    const aRow = await owed(a);
    const outcome = await applyRefundEvent(
      runner,
      event({
        orderId: b.orderId,
        refundRowId: aRow,
        providerRefundId: "re_cross",
        paymentIntentId: b.intent,
      }),
      NOW,
    );
    expect(outcome.result).toBe("mismatched");
  });

  it("reports the order move the state machine refused, without applying it", async () => {
    const s = await seed({ paymentStatus: "pending" });
    const outcome = await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_pendingorder", paymentIntentId: s.intent }),
      NOW,
    );
    expect(outcome.orderMove).toBe("refused");
    expect(await orderStatus(s.orderId)).toBe("pending");
  });
});

describe("an event that changes nothing", () => {
  /*
    A refund read again and found as it was must keep its timestamps. If the
    reading reset them, a refund stuck at pending would look new every hour
    and the three-day alarm could never fire.
  */
  it("writes nothing, so the refund keeps its age", async () => {
    const s = await seed();
    await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_same", paymentIntentId: s.intent, status: "pending" }),
      NOW,
    );
    const before = await db.query<{ updated_at: Date; status_changed_at: Date }>(
      `select updated_at, status_changed_at from refunds where provider_refund_id = 're_same'`,
    );
    await applyRefundEvent(
      runner,
      event({
        providerRefundId: "re_same",
        paymentIntentId: s.intent,
        status: "pending",
        occurredAt: later(120),
      }),
      later(120),
    );
    const after = await db.query<{ updated_at: Date; status_changed_at: Date }>(
      `select updated_at, status_changed_at from refunds where provider_refund_id = 're_same'`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(after.rows[0]!.status_changed_at).toEqual(NOW);
  });

  it("moves the status-change time only when the status moves", async () => {
    const s = await seed();
    await applyRefundEvent(
      runner,
      event({ providerRefundId: "re_moves", paymentIntentId: s.intent, status: "pending" }),
      NOW,
    );
    await applyRefundEvent(
      runner,
      event({
        providerRefundId: "re_moves",
        paymentIntentId: s.intent,
        status: "succeeded",
        occurredAt: later(30),
      }),
      later(30),
    );
    const r = await db.query<{ status_changed_at: Date }>(
      `select status_changed_at from refunds where provider_refund_id = 're_moves'`,
    );
    expect(r.rows[0]!.status_changed_at).toEqual(later(30));
  });
});
