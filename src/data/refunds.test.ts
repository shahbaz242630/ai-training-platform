import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import {
  KEY_WINDOW_MINUTES,
  MAX_REFUND_ATTEMPTS,
  applyRefundEvent,
  backoffMinutes,
  claimDueRefunds,
  closeRefund,
  createWithdrawalRefund,
  keyWindowPassed,
  recomputeOrderRefunds,
  recordRefundIssued,
  recordRefundRetry,
} from "./refunds";
import { loadWithdrawalRefund } from "./refund-queries";
import type { RefundEvent } from "@/domain/payments/provider";

/**
 * Refunds in the database: the row written with a withdrawal, the claim that
 * lets exactly one sweep run ask Stripe for it, the retry rules that decide
 * whether a request is repeated with the same key, and what Stripe's refund
 * events do to the row and the order. A mistake here is money sent twice or
 * money owed and never sent.
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

/** Leave only this refund claimable, so claims in one test do not pick up another's rows. */
async function only(id: string): Promise<void> {
  await db.query(
    `update refunds set status = 'superseded' where id <> $1 and status in ('due', 'issuing')`,
    [id],
  );
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

describe("createWithdrawalRefund", () => {
  it("writes the refund owed, due now, in the order's currency", async () => {
    const s = await seed();
    const id = await owed(s);
    expect(await row(id)).toMatchObject({
      status: "due",
      attempts: 0,
      key_seq: 0,
      origin: "withdrawal",
    });
    expect(Number((await row(id)).amount_fils)).toBe(149900);
    expect(await loadWithdrawalRefund(runner, s.bookingId)).toEqual({
      status: "due",
      providerRefundId: null,
    });
  });

  it("writes one refund per notice, however often it is asked", async () => {
    const s = await seed();
    const first = await owed(s);
    const second = await owed(s);
    expect(second).toBe(first);
  });
});

describe("claimDueRefunds", () => {
  it("claims a due refund once: a second run at the same moment gets nothing", async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    const claimed = await claimDueRefunds(runner, NOW, 5);
    expect(claimed.map((c) => c.id)).toEqual([id]);
    expect(claimed[0]).toMatchObject({
      orderId: s.orderId,
      amountFils: 149900,
      attempts: 1,
      keySeq: 0,
      paymentIntentId: s.intent,
      orderPaymentStatus: "paid",
    });
    expect(await claimDueRefunds(runner, NOW, 5)).toEqual([]);
    expect((await row(id)).status).toBe("issuing");
  });

  it("takes back a claim whose run died, after its lease, with the same key", async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    await claimDueRefunds(runner, NOW, 5);
    expect(await claimDueRefunds(runner, later(4), 5)).toEqual([]);
    const again = await claimDueRefunds(runner, later(6), 5);
    expect(again.map((c) => c.id)).toEqual([id]);
    expect(again[0]).toMatchObject({ attempts: 2, keySeq: 0 });
  });

  it("does not claim a refund waiting for its next attempt", async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    const [claimed] = await claimDueRefunds(runner, NOW, 5);
    await recordRefundRetry(runner, claimed!, { code: "timeout", newKey: false }, NOW);
    expect(await claimDueRefunds(runner, later(4), 5)).toEqual([]);
    expect((await claimDueRefunds(runner, later(6), 5)).map((c) => c.id)).toEqual([id]);
  });
});

describe("recordRefundRetry", () => {
  it("keeps the key after an unclear answer, so a refund that went through is not made twice", async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    const [claimed] = await claimDueRefunds(runner, NOW, 5);
    expect(await recordRefundRetry(runner, claimed!, { code: "timeout", newKey: false }, NOW)).toBe(
      "retry",
    );
    expect(await row(id)).toMatchObject({ status: "due", key_seq: 0, last_error: "timeout" });
  });

  it("moves the key on after a clear refusal, which made nothing", async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    const [claimed] = await claimDueRefunds(runner, NOW, 5);
    await recordRefundRetry(runner, claimed!, { code: "resource_missing", newKey: true }, NOW);
    expect(await row(id)).toMatchObject({ status: "due", key_seq: 1 });
  });

  it(`gives up after ${MAX_REFUND_ATTEMPTS} attempts, for a person to finish`, async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    await db.query(`update refunds set attempts = $2 - 1 where id = $1`, [id, MAX_REFUND_ATTEMPTS]);
    const [claimed] = await claimDueRefunds(runner, NOW, 5);
    expect(await recordRefundRetry(runner, claimed!, { code: "timeout", newKey: false }, NOW)).toBe(
      "gave_up",
    );
    expect(await row(id)).toMatchObject({ status: "failed", last_error: "timeout" });
  });
});

describe("recordRefundIssued", () => {
  it("keeps Stripe's refund, and a succeeded refund marks the order refunded", async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    const [claimed] = await claimDueRefunds(runner, NOW, 5);
    const { move } = await recordRefundIssued(
      runner,
      claimed!,
      { providerRefundId: "re_ok", status: "succeeded" },
      NOW,
    );
    expect(move).toBe("refunded");
    expect(await row(id)).toMatchObject({ status: "succeeded", provider_refund_id: "re_ok" });
    expect(await orderStatus(s.orderId)).toBe("refunded");
  });

  it("leaves the order paid while the refund is pending", async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    const [claimed] = await claimDueRefunds(runner, NOW, 5);
    await recordRefundIssued(
      runner,
      claimed!,
      { providerRefundId: "re_pend", status: "pending" },
      NOW,
    );
    expect(await orderStatus(s.orderId)).toBe("paid");
    expect(await loadWithdrawalRefund(runner, s.bookingId)).toEqual({
      status: "pending",
      providerRefundId: "re_pend",
    });
  });

  // Stripe's event can land before the request's own answer is written.
  it("does not overwrite what an earlier-arriving event already said", async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    const [claimed] = await claimDueRefunds(runner, NOW, 5);
    await applyRefundEvent(
      runner,
      event({
        orderId: s.orderId,
        refundRowId: id,
        providerRefundId: "re_race",
        paymentIntentId: s.intent,
        status: "succeeded",
      }),
      NOW,
    );
    await recordRefundIssued(
      runner,
      claimed!,
      { providerRefundId: "re_race", status: "pending" },
      NOW,
    );
    expect(await row(id)).toMatchObject({ status: "succeeded", provider_refund_id: "re_race" });
  });
});

describe("recordRefundIssued on a row whose claim already ran out", () => {
  // A due row must never hold a refund id, or the sweep would ask for it again.
  it("takes the refund from due too, and clears its wait", async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    const [claimed] = await claimDueRefunds(runner, NOW, 5);
    await db.query(`update refunds set status = 'due', next_attempt_at = $2 where id = $1`, [
      id,
      later(10),
    ]);
    await recordRefundIssued(
      runner,
      claimed!,
      { providerRefundId: "re_from_due", status: "pending" },
      NOW,
    );
    const r = await row(id);
    expect(r).toMatchObject({ status: "pending", provider_refund_id: "re_from_due" });
    expect(r.next_attempt_at).toBeNull();
  });
});

describe("closeRefund", () => {
  it("closes this run's claim on a refund nobody should send", async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    await claimDueRefunds(runner, NOW, 5);
    expect(await closeRefund(runner, id, "superseded", null, NOW)).toBe(true);
    expect((await row(id)).status).toBe("superseded");
  });

  // Stripe's event said what happened while the run was deciding: that stands.
  it("leaves alone a refund an event has already settled", async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    await claimDueRefunds(runner, NOW, 5);
    await applyRefundEvent(
      runner,
      event({
        orderId: s.orderId,
        refundRowId: id,
        providerRefundId: "re_won",
        paymentIntentId: s.intent,
        status: "succeeded",
      }),
      NOW,
    );
    expect(await closeRefund(runner, id, "failed", "timeout", NOW)).toBe(false);
    expect((await row(id)).status).toBe("succeeded");
  });

  it("does not fail a settled refund on the last attempt either", async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    await db.query(`update refunds set attempts = $2 - 1 where id = $1`, [id, MAX_REFUND_ATTEMPTS]);
    const [claimed] = await claimDueRefunds(runner, NOW, 5);
    await applyRefundEvent(
      runner,
      event({
        orderId: s.orderId,
        refundRowId: id,
        providerRefundId: "re_won_late",
        paymentIntentId: s.intent,
        status: "succeeded",
      }),
      NOW,
    );
    expect(await recordRefundRetry(runner, claimed!, { code: "timeout", newKey: false }, NOW)).toBe(
      "already_settled",
    );
    expect((await row(id)).status).toBe("succeeded");
  });

  it("never touches a refund nobody has claimed", async () => {
    const s = await seed();
    const id = await owed(s);
    expect(await closeRefund(runner, id, "failed", "x", NOW)).toBe(false);
    expect((await row(id)).status).toBe("due");
  });
});

describe("backoffMinutes", () => {
  it("waits longer after each attempt, eight hours at most", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map(backoffMinutes)).toEqual([
      5, 10, 30, 60, 120, 240, 480, 480,
    ]);
    expect(backoffMinutes(0)).toBe(5);
  });

  /*
    Stripe keeps a key's answer for 24 hours. Every repeat of an unclear
    request must land inside that, or a refund that went through the first
    time could be made again. Each run can add up to five minutes and a claim
    up to its lease on top of the waits.
  */
  it("fits every attempt inside the key's window, with the sweep's own delays", () => {
    let elapsed = 0;
    for (let attempt = 1; attempt < MAX_REFUND_ATTEMPTS; attempt += 1) {
      elapsed += backoffMinutes(attempt) + 5 + 5;
    }
    expect(elapsed).toBeLessThan(KEY_WINDOW_MINUTES);
    expect(KEY_WINDOW_MINUTES).toBeLessThan(24 * 60);
  });
});

describe("the key's window", () => {
  it("starts when a key is first sent, and starts again with a new key", async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    const [first] = await claimDueRefunds(runner, NOW, 5);
    expect(first!.keyFirstUsedAt).toEqual(NOW);
    await recordRefundRetry(runner, first!, { code: "timeout", newKey: false }, NOW);
    const [second] = await claimDueRefunds(runner, later(6), 5);
    expect(second!.keyFirstUsedAt).toEqual(NOW);
    await recordRefundRetry(runner, second!, { code: "resource_missing", newKey: true }, later(6));
    const [third] = await claimDueRefunds(runner, later(20), 5);
    expect(third!.keyFirstUsedAt).toEqual(later(20));
    expect(third!.keySeq).toBe(1);
  });

  it("is passed once the key is older than it", async () => {
    const s = await seed();
    const id = await owed(s);
    await only(id);
    const [claimed] = await claimDueRefunds(runner, NOW, 5);
    expect(keyWindowPassed(claimed!, later(KEY_WINDOW_MINUTES))).toBe(false);
    expect(keyWindowPassed(claimed!, later(KEY_WINDOW_MINUTES + 1))).toBe(true);
  });
});

describe("what cannot be found", () => {
  it("refuses to write a refund for an order that does not exist", async () => {
    const s = await seed();
    await expect(
      createWithdrawalRefund(runner, {
        orderId: "00000000-0000-4000-8000-0000000000aa",
        withdrawalRequestId: s.noticeId,
        amountFils: 149900,
        now: NOW,
      }),
    ).rejects.toThrow(/vanished/);
  });

  it("moves no order that does not exist", async () => {
    expect(await recomputeOrderRefunds(runner, "00000000-0000-4000-8000-0000000000ab", NOW)).toBe(
      "unchanged",
    );
  });

  it("knows no order for an order id in the metadata that is not ours", async () => {
    const outcome = await applyRefundEvent(
      runner,
      event({ orderId: "00000000-0000-4000-8000-0000000000ac", paymentIntentId: "pi_x" }),
      NOW,
    );
    expect(outcome.result).toBe("unknown_order");
  });
});
