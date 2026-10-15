import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import { createWithdrawalRefund } from "./refunds";
import { countRefundsNeedingAttention } from "./refund-queries";
import { issueDueRefunds, refreshPendingRefunds, reportRefundEvent } from "./refund-issuer";
import { MockPaymentProvider } from "@/domain/payments/mock-provider";
import { RefundRefusedError, RefundUnclearError } from "@/domain/payments/provider";
import { resetAuditSink, setAuditSink, type AuditEvent } from "@/lib/audit";

/**
 * The sweep's refund step against a real schema and the mock processor: one
 * request per refund owed, the same key when the result is unknown, a new
 * key only after a clear refusal, and a person called when it cannot finish.
 */

let db: PGlite;
let runner: QueryRunner;
let n = 0;
const NOW = new Date("2026-10-15T12:00:00Z");
const later = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const transaction = <T>(work: (r: QueryRunner) => Promise<T>) => work(runner);
let audits: AuditEvent[] = [];

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

beforeEach(async () => {
  audits = [];
  setAuditSink((event) => {
    audits.push(event);
  });
  // Each test starts with nothing else owed.
  await db.query(
    `update refunds set status = 'superseded' where status in ('due', 'issuing', 'pending')`,
  );
});

afterEach(() => {
  resetAuditSink();
});

async function owed(
  over: { paymentStatus?: string; intent?: string | null } = {},
): Promise<{ orderId: string; refundId: string; intent: string | null }> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Europe/London') returning id`,
    [`issuer${n}@example.com`],
  );
  const intent = over.intent === undefined ? `pi_issuer_${n}` : over.intent;
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
    [booking.rows[0]!.id, `issuer${n}@example.com`, NOW],
  );
  const refundId = await createWithdrawalRefund(runner, {
    orderId,
    withdrawalRequestId: notice.rows[0]!.id,
    amountFils: 149900,
    now: NOW,
  });
  return { orderId, refundId, intent };
}

const statusOf = async (refundId: string) =>
  (
    await db.query<{ status: string; key_seq: number; last_error: string | null }>(
      `select status, key_seq, last_error from refunds where id = $1`,
      [refundId],
    )
  ).rows[0]!;

const paymentOf = async (orderId: string) =>
  (
    await db.query<{ payment_status: string }>(`select payment_status from orders where id = $1`, [
      orderId,
    ])
  ).rows[0]!.payment_status;

describe("issueDueRefunds", () => {
  it("asks the processor once, for the full amount, against the order's payment", async () => {
    const provider = new MockPaymentProvider();
    const { refundId, orderId, intent } = await owed();

    const report = await issueDueRefunds({ provider, transaction, clock: () => NOW });

    expect(report).toMatchObject({ claimed: 1, issued: 1 });
    expect(provider.refundRequests).toEqual([
      {
        paymentIntentId: intent,
        amountFils: 149900,
        idempotencyKey: `refund:${refundId}:0`,
        metadata: { orderId, refundId },
      },
    ]);
    expect((await statusOf(refundId)).status).toBe("pending");
    expect(audits.map((a) => a.action)).toEqual(["order.refund_requested"]);

    // Nothing is asked for twice.
    await issueDueRefunds({ provider, transaction, clock: () => later(30) });
    expect(provider.refundRequests).toHaveLength(1);
  });

  it("marks the order refunded when the refund succeeds straight away", async () => {
    const provider = new MockPaymentProvider();
    provider.refundStatus = "succeeded";
    const { orderId } = await owed();
    await issueDueRefunds({ provider, transaction, clock: () => NOW });
    expect(await paymentOf(orderId)).toBe("refunded");
    expect(audits.map((a) => a.action)).toEqual(["order.refund_requested", "order.refunded"]);
  });

  it("repeats an unclear request with the same key, so a refund that went through is not made twice", async () => {
    const provider = new MockPaymentProvider();
    provider.refundFailures.push(new RefundUnclearError("timeout"));
    const { refundId } = await owed();

    const first = await issueDueRefunds({ provider, transaction, clock: () => NOW });
    expect(first).toMatchObject({ claimed: 1, retrying: 1 });
    expect(await statusOf(refundId)).toMatchObject({
      status: "due",
      key_seq: 0,
      last_error: "timeout",
    });

    await issueDueRefunds({ provider, transaction, clock: () => later(11) });
    expect(provider.refundRequests.map((r) => r.idempotencyKey)).toEqual([
      `refund:${refundId}:0`,
      `refund:${refundId}:0`,
    ]);
  });

  it("asks again with a new key after a clear refusal", async () => {
    const provider = new MockPaymentProvider();
    provider.refundFailures.push(new RefundRefusedError("resource_missing"));
    const { refundId } = await owed();
    await issueDueRefunds({ provider, transaction, clock: () => NOW });
    await issueDueRefunds({ provider, transaction, clock: () => later(11) });
    expect(provider.refundRequests.map((r) => r.idempotencyKey)).toEqual([
      `refund:${refundId}:0`,
      `refund:${refundId}:1`,
    ]);
  });

  it("stops and calls a person when the payment has already been refunded another way", async () => {
    const provider = new MockPaymentProvider();
    provider.refundFailures.push(new RefundRefusedError("charge_already_refunded"));
    const { refundId } = await owed();
    const report = await issueDueRefunds({ provider, transaction, clock: () => NOW });
    expect(report).toMatchObject({ failed: 1 });
    expect(await statusOf(refundId)).toMatchObject({
      status: "failed",
      last_error: "charge_already_refunded",
    });
    expect(audits.map((a) => a.action)).toEqual(["order.refund_failed"]);
    await issueDueRefunds({ provider, transaction, clock: () => later(60 * 24) });
    expect(provider.refundRequests).toHaveLength(1);
  });

  it("sends nothing for an order already refunded", async () => {
    const provider = new MockPaymentProvider();
    const { refundId } = await owed({ paymentStatus: "refunded" });
    const report = await issueDueRefunds({ provider, transaction, clock: () => NOW });
    expect(report).toMatchObject({ superseded: 1 });
    expect(provider.refundRequests).toEqual([]);
    expect((await statusOf(refundId)).status).toBe("superseded");
  });

  it("leaves a part-refunded order to a person", async () => {
    const provider = new MockPaymentProvider();
    const { refundId } = await owed({ paymentStatus: "partially_refunded" });
    await issueDueRefunds({ provider, transaction, clock: () => NOW });
    expect(provider.refundRequests).toEqual([]);
    expect(await statusOf(refundId)).toMatchObject({
      status: "failed",
      last_error: "order_partially_refunded",
    });
  });

  it("fails a refund with no payment to refund, for a person", async () => {
    const provider = new MockPaymentProvider();
    const { refundId } = await owed({ intent: null });
    await issueDueRefunds({ provider, transaction, clock: () => NOW });
    expect(provider.refundRequests).toEqual([]);
    expect(await statusOf(refundId)).toMatchObject({
      status: "failed",
      last_error: "no_payment_intent",
    });
  });

  it("gives up after the last attempt and calls a person", async () => {
    const provider = new MockPaymentProvider();
    const { refundId } = await owed();
    await db.query(`update refunds set attempts = 7 where id = $1`, [refundId]);
    provider.refundFailures.push(new RefundUnclearError("timeout"));
    const report = await issueDueRefunds({ provider, transaction, clock: () => NOW });
    expect(report).toMatchObject({ failed: 1 });
    expect((await statusOf(refundId)).status).toBe("failed");
    expect(audits.map((a) => a.action)).toEqual(["order.refund_failed"]);
  });

  it("treats an error it does not recognise as unclear: the same key next time", async () => {
    const provider = new MockPaymentProvider();
    provider.refundFailures.push(new Error("socket closed"));
    const { refundId } = await owed();
    await issueDueRefunds({ provider, transaction, clock: () => NOW });
    expect(await statusOf(refundId)).toMatchObject({
      status: "due",
      key_seq: 0,
      last_error: "unknown",
    });
  });
});

describe("issueDueRefunds for an order that was never paid", () => {
  it("fails it for a person rather than asking for money that never came", async () => {
    const provider = new MockPaymentProvider();
    const { refundId } = await owed({ paymentStatus: "failed" });
    await issueDueRefunds({ provider, transaction, clock: () => NOW });
    expect(provider.refundRequests).toEqual([]);
    expect(await statusOf(refundId)).toMatchObject({
      status: "failed",
      last_error: "order_not_paid",
    });
  });
});

describe("reportRefundEvent", () => {
  const base = {
    orderId: "00000000-0000-4000-8000-000000000001",
    refundId: "00000000-0000-4000-8000-000000000002",
    status: "succeeded" as const,
  };

  it("leaves no trail for a stale event", async () => {
    await reportRefundEvent({ ...base, result: "stale", orderMove: "unchanged" }, "evt_s");
    expect(audits).toEqual([]);
  });

  it("records nothing about the order when the order could not take the refund", async () => {
    await reportRefundEvent({ ...base, result: "applied", orderMove: "refused" }, "evt_r");
    expect(audits).toEqual([]);
  });

  it("records an order move only when there is an order to name", async () => {
    await reportRefundEvent(
      { ...base, orderId: null, result: "applied", orderMove: "refunded" },
      "evt_n",
    );
    expect(audits).toEqual([]);
    await reportRefundEvent(
      { ...base, result: "applied", orderMove: "partially_refunded" },
      "evt_p",
    );
    expect(audits.map((a) => a.action)).toEqual(["order.refunded"]);
  });
});

describe("refreshPendingRefunds", () => {
  it("counts nothing as changed while the refund is still on its way", async () => {
    const provider = new MockPaymentProvider();
    const { refundId } = await owed();
    await issueDueRefunds({ provider, transaction, clock: () => NOW });
    const report = await refreshPendingRefunds({ provider, transaction, clock: () => later(61) });
    expect(report).toMatchObject({ checked: 1, changed: 0, failed: 0 });
    expect((await statusOf(refundId)).status).toBe("pending");
  });

  it("reads a quiet pending refund again and applies what the processor says now", async () => {
    const provider = new MockPaymentProvider();
    const { refundId, orderId } = await owed();
    await issueDueRefunds({ provider, transaction, clock: () => NOW });
    const providerRefundId = (
      await db.query<{ provider_refund_id: string }>(
        `select provider_refund_id from refunds where id = $1`,
        [refundId],
      )
    ).rows[0]!.provider_refund_id;
    provider.settleRefund(providerRefundId, "succeeded");

    expect(
      await refreshPendingRefunds({ provider, transaction, clock: () => later(30) }),
    ).toMatchObject({
      checked: 0,
    });
    const report = await refreshPendingRefunds({ provider, transaction, clock: () => later(61) });
    expect(report).toMatchObject({ checked: 1, changed: 1 });
    expect((await statusOf(refundId)).status).toBe("succeeded");
    expect(await paymentOf(orderId)).toBe("refunded");
  });

  it("carries on past a refund it cannot read", async () => {
    const provider = new MockPaymentProvider();
    const { refundId } = await owed();
    await db.query(
      `update refunds set status = 'pending', provider_refund_id = 're_unknown_to_mock',
                          updated_at = $2 where id = $1`,
      [refundId, NOW],
    );
    const report = await refreshPendingRefunds({ provider, transaction, clock: () => later(61) });
    expect(report).toMatchObject({ checked: 1, failed: 1 });
  });
});

describe("the clock", () => {
  /*
    Read at every claim and every record. A wait measured from when the run
    started would be partly spent already by the time a later refund is
    reached, and a lease taken for a batch would run down while the requests
    before it were still being answered.
  */
  it("measures the wait from when the answer was recorded, not from the run's start", async () => {
    const provider = new MockPaymentProvider();
    provider.refundFailures.push(new RefundUnclearError("timeout"));
    const { refundId } = await owed();
    const times = [NOW, later(20), later(20), later(20)];
    let i = 0;
    const clock = () => times[Math.min(i++, times.length - 1)]!;
    await issueDueRefunds({ provider, transaction, clock });
    const r = await db.query<{ next_attempt_at: Date }>(
      `select next_attempt_at from refunds where id = $1`,
      [refundId],
    );
    expect(r.rows[0]!.next_attempt_at).toEqual(later(25));
  });

  it("claims one refund at a time, each with its own lease", async () => {
    const provider = new MockPaymentProvider();
    const a = await owed();
    const b = await owed();
    let minute = 0;
    const leases: Date[] = [];
    const clock = () => later((minute += 1));
    const spying = async <T>(work: (r: QueryRunner) => Promise<T>) => {
      const result = await work(runner);
      const rows = await db.query<{ lease_until: Date | null }>(
        `select lease_until from refunds where id in ($1, $2) and status = 'issuing'`,
        [a.refundId, b.refundId],
      );
      for (const row of rows.rows) if (row.lease_until) leases.push(row.lease_until);
      return result;
    };
    const report = await issueDueRefunds({ provider, transaction: spying, clock });
    expect(report).toMatchObject({ claimed: 2, issued: 2 });
    // Never both claimed at once, and the second lease starts later than the first.
    expect(leases).toHaveLength(2);
    expect(leases[1]!.getTime()).toBeGreaterThan(leases[0]!.getTime());
  });
});

describe("a key older than Stripe keeps its answer", () => {
  it("is never sent again: a person checks the dashboard instead", async () => {
    const provider = new MockPaymentProvider();
    provider.refundFailures.push(new RefundUnclearError("timeout"));
    const { refundId } = await owed();
    await issueDueRefunds({ provider, transaction, clock: () => NOW });
    expect(provider.refundRequests).toHaveLength(1);

    // The sweep was down for a day.
    const report = await issueDueRefunds({ provider, transaction, clock: () => later(24 * 60) });
    expect(report).toMatchObject({ claimed: 1, failed: 1 });
    expect(provider.refundRequests).toHaveLength(1);
    expect(await statusOf(refundId)).toMatchObject({
      status: "failed",
      last_error: "key_window_passed",
    });
  });
});

describe("a refund stuck at pending", () => {
  it("raises the alarm after three days, though it is read again every hour", async () => {
    const provider = new MockPaymentProvider();
    const { refundId } = await owed();
    await issueDueRefunds({ provider, transaction, clock: () => NOW });
    expect((await statusOf(refundId)).status).toBe("pending");
    const baseline = await countRefundsNeedingAttention(runner, NOW);

    let reads = 0;
    for (let hour = 1; hour <= 80; hour += 1) {
      const report = await refreshPendingRefunds({
        provider,
        transaction,
        clock: () => later(hour * 60 + 1),
      });
      reads += report.checked;
    }
    // Read again about once an hour (every second exactly-hourly run), and never moved on.
    expect(reads).toBeGreaterThanOrEqual(35);
    expect((await statusOf(refundId)).status).toBe("pending");
    expect(await countRefundsNeedingAttention(runner, later(80 * 60 + 1))).toBe(baseline + 1);
    // Eighty runs of the refresh: well inside a second alone, slower when the whole suite is running.
  }, 30_000);
});
