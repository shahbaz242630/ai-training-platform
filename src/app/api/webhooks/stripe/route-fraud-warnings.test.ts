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
 * Early fraud warnings through the real webhook route (audit s104 PAY-4):
 * signed delivery in, cancelled session and queued refund out, acted on once
 * however often Stripe delivers it, and retried by Stripe when the database
 * is down.
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

/** A paid order with a confirmed session weeks away. */
async function paidBooking(): Promise<{ orderId: string; bookingId: string; intent: string }> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`fraudroute${n}@example.com`],
  );
  const intent = `pi_fraud_route_${n}`;
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_payment_intent_id)
     values ($1, 'single', 'ai-foundations', 129900, 'paid', $2) returning id`,
    [customer.rows[0]!.id, intent],
  );
  const start = new Date(Date.now() + (30 + n * 7) * 24 * 60 * 60_000);
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, customer_timezone,
                           scheduled_start, scheduled_end)
     values ($1, 'ai-foundations', 1, 'confirmed', 'Asia/Dubai', $2, $3) returning id`,
    [order.rows[0]!.id, start, new Date(start.getTime() + 60 * 60_000)],
  );
  return { orderId: order.rows[0]!.id, bookingId: booking.rows[0]!.id, intent };
}

async function deliver(body: MockEventBody) {
  const raw = mockEventBody(body);
  const headers = new Headers({ "stripe-signature": provider.sign(raw) });
  const response = await POST(
    new Request("https://example.test/api/webhooks/stripe", { method: "POST", headers, body: raw }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const warningEvent = (intent: string): MockEventBody => ({
  id: `evt_${randomUUID()}`,
  type: "radar.early_fraud_warning.created",
  providerWarningId: `issfr_${randomUUID()}`,
  paymentIntentId: intent,
  fraudType: "made_with_stolen_card",
  actionable: true,
});

describe("an early fraud warning delivered to the webhook", () => {
  it("cancels the session and queues the refund, and says so in the audit trail", async () => {
    const s = await paidBooking();
    const { status, body } = await deliver(warningEvent(s.intent));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, outcome: "refund_queued" });

    const booking = await db.query<{ status: string }>(
      `select status from bookings where id = $1`,
      [s.bookingId],
    );
    expect(booking.rows[0]?.status).toBe("cancelled");
    const refunds = await db.query<{ origin: string; status: string }>(
      `select origin, status from refunds where order_id = $1`,
      [s.orderId],
    );
    expect(refunds.rows).toEqual([{ origin: "fraud_warning", status: "due" }]);
    expect(audits.map((a) => a.action)).toContain("order.fraud_warning");
    expect(logs.some((l) => l.level === "error" && /EARLY FRAUD WARNING/.test(l.message))).toBe(
      true,
    );
  });

  it("acts once when Stripe delivers the same event twice", async () => {
    const s = await paidBooking();
    const event = warningEvent(s.intent);
    await deliver(event);
    const again = await deliver(event);
    expect(again).toEqual({ status: 200, body: { ok: true, outcome: "duplicate" } });
    const refunds = await db.query(`select 1 from refunds where order_id = $1`, [s.orderId]);
    expect(refunds.rows).toHaveLength(1);
  });

  it("acts once when Stripe sends the same warning in a new event", async () => {
    const s = await paidBooking();
    const event = warningEvent(s.intent);
    await deliver(event);
    const again = await deliver({ ...event, id: `evt_${randomUUID()}` });
    expect(again.body).toEqual({ ok: true, outcome: "duplicate" });
    const refunds = await db.query(`select 1 from refunds where order_id = $1`, [s.orderId]);
    expect(refunds.rows).toHaveLength(1);
  });

  it("answers 200 for a payment that is not ours, so Stripe does not retry it for days", async () => {
    const { status, body } = await deliver(warningEvent("pi_not_ours"));
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, outcome: "unknown_order" });
  });

  it("answers 500 while the database is down, so Stripe tries again, and stores nothing", async () => {
    const s = await paidBooking();
    state.databaseDown = true;
    const { status } = await deliver(warningEvent(s.intent));
    expect(status).toBe(500);
    state.databaseDown = false;
    const stored = await db.query(
      `select 1 from fraud_warnings f join orders o on o.id = f.order_id where o.id = $1`,
      [s.orderId],
    );
    expect(stored.rows).toHaveLength(0);
  });

  it("refuses a delivery without a valid signature", async () => {
    const raw = mockEventBody(warningEvent("pi_x"));
    const response = await POST(
      new Request("https://example.test/api/webhooks/stripe", {
        method: "POST",
        headers: new Headers({ "stripe-signature": "forged" }),
        body: raw,
      }),
    );
    expect(response.status).toBe(400);
  });
});
