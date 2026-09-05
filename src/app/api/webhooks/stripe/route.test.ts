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
import { holdSlot } from "@/data/slot-holds";
import { attachCheckoutSession, persistPendingOrder } from "@/data/orders";
import { createOrder } from "@/domain/booking/order";
import { AED } from "@/lib/money";
import type { QueryRunner } from "@/data/db";

/**
 * The webhook route, driven end to end: a signed HTTP delivery in, a database
 * state and an HTTP status out.
 *
 * This is the only code that may confirm a payment, and until now it was
 * verified by nothing - the settlement it calls was tested, the signature
 * check it calls was tested, and the route that joins them was outside
 * coverage entirely. The branch that decides what a delayed payment means
 * (the fix for a slot being given away while the customer was still paying)
 * had no test at all.
 *
 * The provider is the mock, which genuinely signs and verifies, so a forged
 * delivery is genuinely rejected. The database is a real in-process Postgres
 * with the real migrations, so the state the route leaves behind is the
 * state production would leave behind.
 */

const state = vi.hoisted(() => ({
  configured: true,
  databaseDown: false,
}));

const provider = new MockPaymentProvider();
let db: PGlite;

vi.mock("@/domain/payments/factory", () => ({
  getPaymentProvider: () => {
    if (!state.configured) throw new Error("STRIPE_SECRET_KEY is not configured");
    return provider;
  },
  paymentsAreConfigured: () => state.configured,
}));

vi.mock("@/data/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/db")>()),
  withTransaction: async <T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> => {
    if (state.databaseDown) throw new Error("connection refused");
    return db.transaction((tx) => work(tx as unknown as QueryRunner));
  },
}));

import { POST } from "./route";

const NOW = new Date("2027-10-01T09:00:00Z");
const SLOT_START = new Date("2027-10-20T14:00:00Z");
const AMOUNT_FILS = 129900;

let runner: QueryRunner;
let audits: AuditEvent[];
let logs: LogRecord[];

beforeAll(async () => {
  db = await PGlite.create();
  // PGlite's multi-statement entry point, applying the real migration files.
  const applySql = db.exec.bind(db);
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    await applySql(readFileSync(join(dir, file), "utf8"));
  }
  runner = db as unknown as QueryRunner;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  state.configured = true;
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

let slotCounter = 0;
let emailCounter = 0;

/** A pending order with its booking and a live hold - the state checkout leaves behind. */
async function pendingOrder() {
  emailCounter += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`webhook${emailCounter}@example.com`],
  );
  const customerId = customer.rows[0]?.id ?? "";
  const intake = await db.query<{ id: string }>(
    `insert into intakes (customer_id, primary_goal) values ($1, 'Ship') returning id`,
    [customerId],
  );

  slotCounter += 1;
  const start = new Date(SLOT_START.getTime() + slotCounter * 3 * 60 * 60_000);
  const held = await holdSlot(
    {
      slotStart: start,
      slotEnd: new Date(start.getTime() + 90 * 60_000),
      // The route settles against the real clock, so the hold must be live now.
      expiresAt: new Date(Date.now() + 35 * 60_000),
    },
    (work) => work(runner),
  );
  if (!held.ok) throw new Error("test setup could not take a hold");

  const order = createOrder({
    id: randomUUID(),
    customerId,
    orderType: "single",
    sessionSlug: "ai-foundations",
    grossAmountFils: AMOUNT_FILS,
    currency: AED,
    taxRateBasisPoints: 0,
    intakeId: intake.rows[0]?.id ?? "",
    now: NOW,
  });

  await persistPendingOrder(runner, {
    order,
    sessionSlug: "ai-foundations",
    slotStart: start,
    slotEnd: new Date(start.getTime() + 90 * 60_000),
    customerTimezone: "Asia/Dubai",
    slotHoldId: held.hold.id,
  });

  return { orderId: order.id, slotHoldId: held.hold.id };
}

/** A delivery the way the processor would send it: raw body, signature header. */
async function deliver(body: MockEventBody, signature?: string | null, forwardedFor?: string) {
  const raw = mockEventBody(body);
  const headers = new Headers();
  const presented = signature === undefined ? provider.sign(raw) : signature;
  if (presented !== null) headers.set("stripe-signature", presented);
  if (forwardedFor !== undefined) headers.set("x-forwarded-for", forwardedFor);

  const response = await POST(
    new Request("https://example.test/api/webhooks/stripe", {
      method: "POST",
      headers,
      body: raw,
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const paidEvent = (orderId: string, slotHoldId: string, extra: Partial<MockEventBody> = {}) => ({
  id: `evt_${randomUUID()}`,
  type: "checkout.session.completed",
  orderId,
  slotHoldId,
  paymentStatus: "paid" as const,
  amountFils: AMOUNT_FILS,
  currency: "aed",
  ...extra,
});

async function stateOf(orderId: string, slotHoldId: string) {
  const order = await db.query<{ payment_status: string }>(
    "select payment_status from orders where id = $1",
    [orderId],
  );
  const booking = await db.query<{ status: string }>(
    "select status from bookings where order_id = $1",
    [orderId],
  );
  const hold = await db.query<{ status: string }>("select status from slot_holds where id = $1", [
    slotHoldId,
  ]);
  return {
    order: order.rows[0]?.payment_status,
    booking: booking.rows[0]?.status,
    hold: hold.rows[0]?.status,
  };
}

async function claimsFor(eventId: string) {
  const result = await db.query<{ processed_at: Date | null }>(
    "select processed_at from webhook_events where external_event_id = $1",
    [eventId],
  );
  return result.rows;
}

const errorMessages = () => logs.filter((l) => l.level === "error").map((l) => l.message);
const auditActions = () => audits.map((a) => a.action);

describe("before anything is verified", () => {
  it("answers 500 and touches nothing when payments are not configured", async () => {
    state.configured = false;
    const { orderId, slotHoldId } = await pendingOrder();
    const event = paidEvent(orderId, slotHoldId);

    const result = await deliver(event);

    expect(result).toEqual({ status: 500, body: { error: "Not configured" } });
    expect(await stateOf(orderId, slotHoldId)).toEqual({
      order: "pending",
      booking: "awaiting_schedule",
      hold: "held",
    });
    expect(await claimsFor(event.id)).toEqual([]);
    expect(errorMessages()).toContain("a stripe webhook arrived while payments are not configured");
  });

  it("rejects a delivery with no signature header, and records the rejection", async () => {
    const { orderId, slotHoldId } = await pendingOrder();
    const event = paidEvent(orderId, slotHoldId);

    const result = await deliver(event, null);

    expect(result).toEqual({ status: 400, body: { error: "Invalid signature" } });
    expect(await stateOf(orderId, slotHoldId)).toMatchObject({ order: "pending", hold: "held" });
    expect(await claimsFor(event.id)).toEqual([]);
    expect(auditActions()).toEqual(["webhook.signature_rejected"]);
  });

  it("rejects a body that was changed after it was signed", async () => {
    const { orderId, slotHoldId } = await pendingOrder();
    const event = paidEvent(orderId, slotHoldId);
    const signatureOfSomethingElse = provider.sign(mockEventBody({ ...event, amountFils: 1 }));

    const result = await deliver(event, signatureOfSomethingElse);

    expect(result.status).toBe(400);
    expect(await stateOf(orderId, slotHoldId)).toMatchObject({ order: "pending", hold: "held" });
    expect(auditActions()).toEqual(["webhook.signature_rejected"]);
  });
});

describe("verified deliveries that carry nothing to act on", () => {
  it("acknowledges and drops an event type this integration does not consume", async () => {
    const event = { id: `evt_${randomUUID()}`, type: "customer.created" };

    const result = await deliver(event);

    expect(result).toEqual({ status: 200, body: { ok: true, ignored: "customer.created" } });
    expect(await claimsFor(event.id)).toEqual([]);
  });

  it("acknowledges rather than retries an order id that is not a UUID", async () => {
    const event = paidEvent("not-a-uuid'; drop table orders; --", randomUUID());

    const result = await deliver(event);

    expect(result).toEqual({ status: 200, body: { ok: true, ignored: "malformed order id" } });
    expect(await claimsFor(event.id)).toEqual([]);
    expect(errorMessages()).toContain("a payment event carried an order id that is not a UUID");
  });

  it("acknowledges a consumable event that names no order, and says so", async () => {
    const event = {
      id: `evt_${randomUUID()}`,
      type: "checkout.session.completed",
      paymentStatus: "paid" as const,
    };

    const result = await deliver(event);

    expect(result).toEqual({ status: 200, body: { ok: true, ignored: "no order id" } });
    expect(errorMessages()).toContain("a stripe event we consume carried no order id");
  });
});

describe("a paid delivery", () => {
  it("settles the order, converts the hold, schedules the booking, and marks the claim processed", async () => {
    const { orderId, slotHoldId } = await pendingOrder();
    const event = paidEvent(orderId, slotHoldId, { paymentIntentId: "pi_test_1" });

    const result = await deliver(event);

    expect(result).toEqual({ status: 200, body: { ok: true, outcome: "settled" } });
    expect(await stateOf(orderId, slotHoldId)).toEqual({
      order: "paid",
      booking: "scheduled",
      hold: "converted",
    });
    const [claim] = await claimsFor(event.id);
    expect(claim?.processed_at).not.toBeNull();
    expect(audits).toContainEqual(
      expect.objectContaining({ action: "order.payment_succeeded", subject: `order:${orderId}` }),
    );
    expect(errorMessages()).toEqual([]);

    // The handle a refund will need, taken from the event rather than left
    // null - which is exactly how the first real payment was stored.
    const stored = await db.query<{ stripe_payment_intent_id: string | null }>(
      "select stripe_payment_intent_id from orders where id = $1",
      [orderId],
    );
    expect(stored.rows[0]?.stripe_payment_intent_id).toBe("pi_test_1");

    // The first thing a paying customer will receive, promised in the same
    // transaction as the settlement.
    const queued = await db.query<{ template_key: string; status: string }>(
      `select template_key, status from communication_log
        where booking_id = (select id from bookings where order_id = $1)`,
      [orderId],
    );
    expect(queued.rows).toEqual([{ template_key: "payment_receipt", status: "queued" }]);
  });

  it("does nothing the second time the same event arrives", async () => {
    const { orderId, slotHoldId } = await pendingOrder();
    const event = paidEvent(orderId, slotHoldId);
    await deliver(event);
    audits = [];
    logs = [];

    const result = await deliver(event);

    expect(result).toEqual({ status: 200, body: { ok: true, outcome: "duplicate" } });
    expect(await claimsFor(event.id)).toHaveLength(1);
    expect(auditActions()).toEqual(["webhook.duplicate_ignored"]);
    // Visible in the log as well as the trail: a redelivery storm should be
    // readable where somebody looks first, and it is not an error.
    expect(logs).toContainEqual(
      expect.objectContaining({ level: "info", message: "a duplicate delivery was ignored" }),
    );
    expect(errorMessages()).toEqual([]);
    expect(await stateOf(orderId, slotHoldId)).toEqual({
      order: "paid",
      booking: "scheduled",
      hold: "converted",
    });
  });

  it("reports a fresh event for an already-paid order as already settled, and redoes nothing", async () => {
    const { orderId, slotHoldId } = await pendingOrder();
    await deliver(paidEvent(orderId, slotHoldId));
    audits = [];

    const result = await deliver(
      paidEvent(orderId, slotHoldId, { type: "checkout.session.async_payment_succeeded" }),
    );

    expect(result).toEqual({ status: 200, body: { ok: true, outcome: "already_settled" } });
    expect(auditActions()).toEqual([]);
  });

  it("keeps the order paid but unscheduled when the hold has already gone, and shouts", async () => {
    const { orderId, slotHoldId } = await pendingOrder();
    await db.query("update slot_holds set status = 'expired' where id = $1", [slotHoldId]);

    const result = await deliver(paidEvent(orderId, slotHoldId));

    expect(result).toEqual({ status: 200, body: { ok: true, outcome: "paid_without_slot" } });
    expect(await stateOf(orderId, slotHoldId)).toEqual({
      order: "paid",
      booking: "awaiting_schedule",
      hold: "expired",
    });
    expect(errorMessages()).toContain(
      "PAID BUT NOT SCHEDULED - needs rescheduling by hand, do not charge again",
    );
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: "order.payment_succeeded",
        metadata: expect.objectContaining({ scheduled: false }),
      }),
    );
  });
});

describe("a delivery whose money is still in flight", () => {
  it("waits: order stays pending, hold stays held, nothing is released", async () => {
    const { orderId, slotHoldId } = await pendingOrder();
    const event = paidEvent(orderId, slotHoldId, { paymentStatus: "unpaid" });

    const result = await deliver(event);

    expect(result).toEqual({ status: 200, body: { ok: true, outcome: "awaiting_payment" } });
    expect(await stateOf(orderId, slotHoldId)).toEqual({
      order: "pending",
      booking: "awaiting_schedule",
      hold: "held",
    });
    // Claimed, so a retry of this exact delivery is a no-op rather than a second
    // look - and marked processed, because deciding to wait IS handling it.
    const claims = await claimsFor(event.id);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.processed_at).not.toBeNull();
    expect(errorMessages()).toEqual([]);
  });

  it("settles when the result arrives later as its own event", async () => {
    const { orderId, slotHoldId } = await pendingOrder();
    await deliver(paidEvent(orderId, slotHoldId, { paymentStatus: "unpaid" }));

    const result = await deliver(
      paidEvent(orderId, slotHoldId, { type: "checkout.session.async_payment_succeeded" }),
    );

    expect(result.body).toMatchObject({ outcome: "settled" });
    expect(await stateOf(orderId, slotHoldId)).toEqual({
      order: "paid",
      booking: "scheduled",
      hold: "converted",
    });
  });
});

describe("a failed or expired delivery", () => {
  it("marks the order failed and releases the slot on a payment failure", async () => {
    const { orderId, slotHoldId } = await pendingOrder();

    const result = await deliver(
      paidEvent(orderId, slotHoldId, {
        type: "checkout.session.async_payment_failed",
        paymentStatus: "unpaid",
      }),
    );

    expect(result).toEqual({ status: 200, body: { ok: true, outcome: "released" } });
    expect(await stateOf(orderId, slotHoldId)).toEqual({
      order: "failed",
      booking: "awaiting_schedule",
      hold: "released",
    });
    expect(auditActions()).toEqual(["order.payment_failed"]);
  });

  it("releases the slot when the checkout session expires unpaid", async () => {
    const { orderId, slotHoldId } = await pendingOrder();

    const result = await deliver(
      paidEvent(orderId, slotHoldId, { type: "checkout.session.expired", paymentStatus: "unpaid" }),
    );

    expect(result.body).toMatchObject({ outcome: "released" });
    expect(await stateOf(orderId, slotHoldId)).toMatchObject({ order: "failed", hold: "released" });
  });

  it("still lets a later successful payment settle a failed order", async () => {
    const { orderId, slotHoldId } = await pendingOrder();
    await deliver(
      paidEvent(orderId, slotHoldId, {
        type: "checkout.session.async_payment_failed",
        paymentStatus: "unpaid",
      }),
    );

    const result = await deliver(
      paidEvent(orderId, slotHoldId, { type: "checkout.session.async_payment_succeeded" }),
    );

    // The hold was released with the failure, so the money is kept and a
    // human reschedules - never a silent double booking, never a second charge.
    expect(result.body).toMatchObject({ outcome: "paid_without_slot" });
    expect(await stateOf(orderId, slotHoldId)).toMatchObject({ order: "paid", hold: "released" });
  });
});

describe("a verified delivery that does not belong to the order it names", () => {
  it("refuses to settle when the amount differs, and keeps durable evidence", async () => {
    const { orderId, slotHoldId } = await pendingOrder();

    const result = await deliver(paidEvent(orderId, slotHoldId, { amountFils: 100 }));

    expect(result).toEqual({ status: 200, body: { ok: true, outcome: "mismatched" } });
    expect(await stateOf(orderId, slotHoldId)).toEqual({
      order: "pending",
      booking: "awaiting_schedule",
      hold: "held",
    });
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: "webhook.signature_rejected",
        subject: `order:${orderId}`,
        metadata: expect.objectContaining({ reason: "event did not match the order it named" }),
      }),
    );
    expect(errorMessages()).toContain("a payment event did not match the order it named");
  });

  it("refuses to settle when the checkout session is not the one we started", async () => {
    const { orderId, slotHoldId } = await pendingOrder();
    await attachCheckoutSession(runner, orderId, "cs_ours");

    const result = await deliver(
      paidEvent(orderId, slotHoldId, { checkoutSessionId: "cs_somebody_elses" }),
    );

    expect(result.body).toMatchObject({ outcome: "mismatched" });
    expect(await stateOf(orderId, slotHoldId)).toMatchObject({ order: "pending", hold: "held" });
  });

  it("refuses to release a slot on a failure event that does not match either", async () => {
    const { orderId, slotHoldId } = await pendingOrder();

    const result = await deliver(
      paidEvent(orderId, slotHoldId, {
        type: "checkout.session.async_payment_failed",
        paymentStatus: "unpaid",
        amountFils: 100,
      }),
    );

    expect(result.body).toMatchObject({ outcome: "mismatched" });
    expect(await stateOf(orderId, slotHoldId)).toMatchObject({ order: "pending", hold: "held" });
  });

  it("acknowledges an order we have never written, and keeps evidence of the guess", async () => {
    const orderId = randomUUID();

    const result = await deliver(paidEvent(orderId, randomUUID()));

    expect(result).toEqual({ status: 200, body: { ok: true, outcome: "unknown_order" } });
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: "webhook.signature_rejected",
        metadata: expect.objectContaining({ reason: "no such order" }),
      }),
    );
    expect(errorMessages()).toContain("a verified payment event named an order we do not have");
  });

  it("acknowledges a success for an order the state machine will not move", async () => {
    const { orderId, slotHoldId } = await pendingOrder();
    await db.query("update orders set payment_status = 'refunded' where id = $1", [orderId]);

    const result = await deliver(paidEvent(orderId, slotHoldId));

    expect(result).toEqual({ status: 200, body: { ok: true, outcome: "refused" } });
    expect(await stateOf(orderId, slotHoldId)).toMatchObject({ order: "refunded", hold: "held" });
    expect(audits).toContainEqual(
      expect.objectContaining({
        action: "webhook.signature_rejected",
        metadata: expect.objectContaining({ reason: "state machine refused the move" }),
      }),
    );
  });
});

describe("when the database cannot be reached", () => {
  it("answers 500 so the processor retries, and claims nothing", async () => {
    const { orderId, slotHoldId } = await pendingOrder();
    const event = paidEvent(orderId, slotHoldId);
    state.databaseDown = true;

    const result = await deliver(event);

    expect(result).toEqual({ status: 500, body: { error: "Could not settle" } });
    expect(errorMessages()).toContain("a stripe webhook could not be settled");

    state.databaseDown = false;
    expect(await claimsFor(event.id)).toEqual([]);
    // The retry then starts cleanly and settles.
    expect((await deliver(event)).body).toMatchObject({ outcome: "settled" });
  });
});

describe("evidence of forged deliveries is bounded", () => {
  const warnings = () => logs.filter((l) => l.level === "warn").map((l) => l.message);

  it("records the first few rejections from a source, then keeps refusing without recording", async () => {
    const { orderId, slotHoldId } = await pendingOrder();
    const event = paidEvent(orderId, slotHoldId);
    const forged = provider.sign(mockEventBody({ ...event, amountFils: 1 }));

    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      statuses.push((await deliver(event, forged, "203.0.113.7")).status);
    }

    // Every one refused; only the first five left a row behind.
    expect(statuses).toEqual([400, 400, 400, 400, 400, 400, 400]);
    expect(auditActions().filter((a) => a === "webhook.signature_rejected")).toHaveLength(5);
    expect(warnings()).toEqual([
      "a forged delivery was refused but not recorded: evidence budget spent",
      "a forged delivery was refused but not recorded: evidence budget spent",
    ]);
    expect(errorMessages()).toHaveLength(7);
    expect(await stateOf(orderId, slotHoldId)).toMatchObject({ order: "pending", hold: "held" });
  });

  it("does not let one noisy source silence the evidence of another", async () => {
    const { orderId, slotHoldId } = await pendingOrder();
    const event = paidEvent(orderId, slotHoldId);
    const forged = provider.sign(mockEventBody({ ...event, amountFils: 1 }));

    for (let i = 0; i < 8; i += 1) await deliver(event, forged, "203.0.113.8");
    audits = [];

    await deliver(event, forged, "203.0.113.9");

    expect(auditActions()).toEqual(["webhook.signature_rejected"]);
  });
});
