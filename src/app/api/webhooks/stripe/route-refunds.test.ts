import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MockPaymentProvider,
  mockEventBody,
  type MockEventBody,
} from "@/domain/payments/mock-provider";
import { resetAuditSink, setAuditSink, type AuditEvent } from "@/lib/audit";
import { resetLogSink, setLogSink, type LogRecord } from "@/lib/logger";
import type { QueryRunner } from "@/data/db";

/**
 * Refund events through the real webhook route: signed delivery in, refund
 * row and order status out. The case that motivated it: a refund made by hand
 * in the Stripe dashboard left the order saying "paid", because nothing
 * listened and the payment path dropped any event without our order id.
 */

const state = vi.hoisted(() => ({ databaseDown: false }));
const provider = new MockPaymentProvider();
let db: PGlite;

vi.mock("@/domain/payments/factory", () => ({
  getPaymentProvider: () => provider,
  paymentsAreConfigured: () => true,
}));

vi.mock("@/data/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/db")>()),
  withTransaction: async <T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> => {
    if (state.databaseDown) throw new Error("connection refused");
    return db.transaction((tx) => work(tx as unknown as QueryRunner));
  },
}));

import { POST } from "./route";

let audits: AuditEvent[];
let logs: LogRecord[];
let n = 0;

beforeAll(async () => {
  db = await PGlite.create();
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(dir, file), "utf8"));
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  state.databaseDown = false;
  audits = [];
  logs = [];
  setAuditSink((event) => {
    audits.push(event);
  });
  setLogSink((record) => {
    logs.push(record);
  });
});

afterEach(() => {
  resetAuditSink();
  resetLogSink();
});

/** A paid order with its payment intent stored, as settlement leaves it. */
async function paidOrder(): Promise<{ orderId: string; intent: string }> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`refundroute${n}@example.com`],
  );
  const intent = `pi_route_${n}`;
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_payment_intent_id)
     values ($1, 'single', 'ai-foundations', 129900, 'paid', $2) returning id`,
    [customer.rows[0]!.id, intent],
  );
  return { orderId: order.rows[0]!.id, intent };
}

async function deliver(body: MockEventBody) {
  const raw = mockEventBody(body);
  const headers = new Headers({ "stripe-signature": provider.sign(raw) });
  const response = await POST(
    new Request("https://example.test/api/webhooks/stripe", { method: "POST", headers, body: raw }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const refundEvent = (extra: Partial<MockEventBody>): MockEventBody => ({
  id: `evt_${randomUUID()}`,
  type: "refund.updated",
  providerRefundId: `re_${randomUUID()}`,
  amountFils: 129900,
  currency: "aed",
  refundStatus: "succeeded",
  createdAtIso: "2027-10-01T09:00:00Z",
  ...extra,
});

const paymentOf = async (orderId: string) =>
  (
    await db.query<{ payment_status: string }>(`select payment_status from orders where id = $1`, [
      orderId,
    ])
  ).rows[0]!.payment_status;

const actions = () => audits.map((a) => a.action);

describe("a refund made in the dashboard", () => {
  it("reaches the order through its payment, though it carries no order id", async () => {
    const { orderId, intent } = await paidOrder();
    const result = await deliver(refundEvent({ paymentIntentId: intent }));

    expect(result).toEqual({ status: 200, body: { ok: true, outcome: "applied" } });
    expect(await paymentOf(orderId)).toBe("refunded");
    expect(actions()).toEqual(["order.refunded"]);
  });

  it("is applied once however often it is delivered", async () => {
    const { orderId, intent } = await paidOrder();
    const event = refundEvent({ paymentIntentId: intent, amountFils: 50000 });
    await deliver(event);
    const again = await deliver(event);
    expect(again.body).toEqual({ ok: true, outcome: "duplicate" });
    const total = await db.query<{ total: string | number }>(
      `select coalesce(sum(amount_fils), 0) as total from refunds where order_id = $1`,
      [orderId],
    );
    expect(Number(total.rows[0]!.total)).toBe(50000);
    expect(await paymentOf(orderId)).toBe("partially_refunded");
  });
});

describe("a refund we cannot place", () => {
  it("is acknowledged, changes nothing, and is kept as evidence", async () => {
    const result = await deliver(refundEvent({ paymentIntentId: "pi_nobody_knows" }));
    expect(result).toEqual({ status: 200, body: { ok: true, outcome: "unknown_order" } });
    expect(actions()).toEqual(["admin.action"]);
    expect(logs.some((l) => l.level === "error")).toBe(true);
    // Held for the payment, in case it is ours and has not settled yet (audit s104 PAY-2).
    const held = await db.query(`select 1 from held_refund_events where payment_intent_id = $1`, [
      "pi_nobody_knows",
    ]);
    expect(held.rows).toHaveLength(1);
  });

  it("does not hold one that carries our metadata: that one is ours or nobody's", async () => {
    const intent = `pi_${randomUUID()}`;
    await deliver(refundEvent({ orderId: randomUUID(), paymentIntentId: intent }));
    const held = await db.query(`select 1 from held_refund_events where payment_intent_id = $1`, [
      intent,
    ]);
    expect(held.rows).toHaveLength(0);
  });

  it("refuses one that names our order but another payment", async () => {
    const { orderId } = await paidOrder();
    const result = await deliver(refundEvent({ orderId, paymentIntentId: "pi_other" }));
    expect(result.body).toEqual({ ok: true, outcome: "mismatched" });
    expect(await paymentOf(orderId)).toBe("paid");
  });

  it("acknowledges an order id in the metadata that is not one of ours at all", async () => {
    const result = await deliver(refundEvent({ orderId: "not-a-uuid" }));
    expect(result).toEqual({ status: 200, body: { ok: true, outcome: "unknown_order" } });
  });
});

describe("a refund that fails after it was made", () => {
  it("calls a person", async () => {
    const { intent } = await paidOrder();
    const providerRefundId = `re_${randomUUID()}`;
    await deliver(refundEvent({ paymentIntentId: intent, providerRefundId }));
    audits = [];
    await deliver(
      refundEvent({
        paymentIntentId: intent,
        providerRefundId,
        refundStatus: "failed",
        createdAtIso: "2027-10-01T10:00:00Z",
      }),
    );
    expect(actions()).toEqual(["order.refund_failed"]);
    expect(logs.some((l) => l.level === "error" && /REFUND FAILED/.test(l.message))).toBe(true);
  });
});

describe("when the database is down", () => {
  it("answers 500 so Stripe tries again, and claims nothing", async () => {
    state.databaseDown = true;
    const event = refundEvent({ paymentIntentId: "pi_any" });
    const result = await deliver(event);
    expect(result.status).toBe(500);
    state.databaseDown = false;
    const claims = await db.query(`select 1 from webhook_events where external_event_id = $1`, [
      event.id,
    ]);
    expect(claims.rows).toEqual([]);
  });
});
