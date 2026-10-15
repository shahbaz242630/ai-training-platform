import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import { countRefundsNeedingAttention, listRefundsNeedingAttention } from "./refunds";
import { bookingReference } from "@/domain/booking/withdrawal";

/**
 * The refunds a person must look at, as a list the desk alert can be written
 * from. The count the sweep reports is this list's length, so the alarm and
 * the email can never disagree about what needs attention.
 */

let db: PGlite;
let runner: QueryRunner;
let n = 0;
const NOW = new Date("2026-10-16T12:00:00Z");

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
  await db.query(`delete from refunds`);
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
