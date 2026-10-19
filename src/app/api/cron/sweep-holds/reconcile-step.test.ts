import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { QueryRunner } from "@/data/db";
import { persistPendingOrder } from "@/data/orders";
import { holdSlot } from "@/data/slot-holds";
import { createOrder } from "@/domain/booking/order";
import { MockEmailProvider } from "@/domain/messaging/mock-provider";
import { MockPaymentProvider } from "@/domain/payments/mock-provider";
import { resetAuditSink, setAuditSink } from "@/lib/audit";
import { resetLogSink, setLogSink } from "@/lib/logger";
import { AED } from "@/lib/money";
import { reconcilePendingOrders } from "./reconcile-step";

/**
 * The safety net for payment events that never arrived: an order still
 * pending long after its checkout is settled by asking the processor, through
 * the webhook's own path, and the desk is told the events are missing.
 */

let db: PGlite;
let runner: QueryRunner;
let mail: MockEmailProvider;
let payments: MockPaymentProvider;
let confirmed: string[];
let n = 0;
const NOW = new Date("2027-10-01T12:00:00Z");
const DESK = "desk@example.com";

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
  // Every earlier order is settled one way or another, so each test sees only its own.
  await db.query(`update orders set payment_status = 'failed' where payment_status = 'pending'`);
  await db.query(`update orders set reconciled_at = null`);
  await db.query(`delete from desk_alerts`);
  mail = new MockEmailProvider();
  payments = new MockPaymentProvider();
  confirmed = [];
  setLogSink(() => undefined);
  setAuditSink(() => undefined);
});

afterEach(() => {
  resetLogSink();
  resetAuditSink();
});

const run = (now = NOW) =>
  reconcilePendingOrders({
    provider: () => payments,
    transaction: (work) => db.transaction((tx) => work(tx as unknown as QueryRunner)),
    clock: () => now,
    email: () => mail,
    desk: () => DESK,
    confirm: (orderId) => {
      confirmed.push(orderId);
      return Promise.resolve();
    },
  });

/** A pending order whose checkout began `minutesAgo` before NOW, with its live hold. */
async function pending(minutesAgo: number) {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`reconcile${n}@example.com`],
  );
  const customerId = customer.rows[0]!.id;
  const intake = await db.query<{ id: string }>(
    `insert into intakes (customer_id, primary_goal) values ($1, 'Ship') returning id`,
    [customerId],
  );
  const start = new Date(Date.UTC(2027, 10, 1, 15) + n * 3 * 60 * 60_000);
  const end = new Date(start.getTime() + 90 * 60_000);
  const began = new Date(NOW.getTime() - minutesAgo * 60_000);
  const held = await holdSlot(
    { slotStart: start, slotEnd: end, expiresAt: new Date(began.getTime() + 35 * 60_000) },
    (work) => work(runner),
  );
  if (!held.ok) throw new Error("test setup could not take a hold");
  const order = createOrder({
    id: randomUUID(),
    customerId,
    orderType: "single",
    sessionSlug: "ai-foundations",
    grossAmountFils: 129900,
    currency: AED,
    taxRateBasisPoints: 0,
    intakeId: intake.rows[0]!.id,
    now: began,
  });
  await persistPendingOrder(runner, {
    order,
    sessionSlug: "ai-foundations",
    slotStart: start,
    slotEnd: end,
    customerTimezone: "Asia/Dubai",
    slotHoldId: held.hold.id,
  });
  const sessionId = `cs_reconcile_${n}`;
  await db.query(
    `update orders set stripe_checkout_session_id = $2, created_at = $3 where id = $1`,
    [order.id, sessionId, began],
  );
  return { orderId: order.id, slotHoldId: held.hold.id, sessionId };
}

const paid = (o: { orderId: string; slotHoldId: string; sessionId: string }) => ({
  checkoutSessionId: o.sessionId,
  paymentIntentId: `pi_${o.sessionId}`,
  orderId: o.orderId,
  slotHoldId: o.slotHoldId,
  outcome: "paid" as const,
  amountFils: 129900,
  currency: "aed",
});

const orderState = async (orderId: string) =>
  (
    await db.query<{ payment_status: string; reconciled: boolean; booking: string }>(
      `select o.payment_status, (o.reconciled_at is not null) as reconciled, b.status as booking
         from orders o join bookings b on b.order_id = o.id where o.id = $1`,
      [orderId],
    )
  ).rows[0];

describe("reconcilePendingOrders", () => {
  it("books a paid customer whose event never came, and tells the desk", async () => {
    const o = await pending(60);
    payments.checkoutSnapshots.set(o.sessionId, paid(o));

    const report = await run();

    expect(report).toMatchObject({ asked: 1, settled: 1, failed: 0 });
    expect(await orderState(o.orderId)).toEqual({
      payment_status: "paid",
      reconciled: true,
      booking: "scheduled",
    });
    expect(confirmed).toEqual([o.orderId]);
    const receipt = await db.query(
      `select 1 from communication_log c join bookings b on b.id = c.booking_id
        where b.order_id = $1 and c.template_key = 'payment_receipt'`,
      [o.orderId],
    );
    expect(receipt.rows).toHaveLength(1);
    expect(mail.sent.map((m) => [m.to, m.subject])).toEqual([
      [DESK, "Payment notices from Stripe are delayed or missing (1 in the last day)"],
    ]);
  });

  it("releases an abandoned checkout whose expiry event never came", async () => {
    const o = await pending(60);
    payments.checkoutSnapshots.set(o.sessionId, {
      ...paid(o),
      paymentIntentId: null,
      outcome: "failed",
    });

    expect(await run()).toMatchObject({ released: 1 });
    expect((await orderState(o.orderId))?.payment_status).toBe("failed");
  });

  it("never asks about a checkout that may still be open", async () => {
    const o = await pending(20);
    payments.checkoutSnapshots.set(o.sessionId, paid(o));

    expect(await run()).toMatchObject({ asked: 0 });
    expect((await orderState(o.orderId))?.payment_status).toBe("pending");
  });

  it("waits on money still in flight, and tells nobody", async () => {
    const o = await pending(60);
    payments.checkoutSnapshots.set(o.sessionId, { ...paid(o), outcome: "unpaid" });

    expect(await run()).toMatchObject({ asked: 1, waiting: 1, settled: 0 });
    expect((await orderState(o.orderId))?.payment_status).toBe("pending");
    expect(mail.sent).toEqual([]);
  });

  it("applies only to the order it asked about, whatever the session names", async () => {
    const o = await pending(60);
    const other = await pending(60);
    // A session naming another order: settlement checks it against the order asked about.
    payments.checkoutSnapshots.set(o.sessionId, { ...paid(o), orderId: other.orderId });
    payments.checkoutSnapshots.set(other.sessionId, { ...paid(other), outcome: "unpaid" });

    await run();

    expect((await orderState(other.orderId))?.payment_status).toBe("pending");
    expect((await orderState(o.orderId))?.payment_status).toBe("paid");
  });

  it("keeps going when the processor cannot answer about one order", async () => {
    const broken = await pending(61);
    const fine = await pending(60);
    payments.checkoutSnapshots.set(fine.sessionId, paid(fine));

    expect(await run()).toMatchObject({ asked: 2, failed: 1, settled: 1 });
    expect((await orderState(broken.orderId))?.payment_status).toBe("pending");
  });

  it("takes turns: orders that never settle cannot crowd a newer one out", async () => {
    const stuck = [];
    for (let i = 0; i < 5; i++) stuck.push(await pending(120 - i));
    for (const o of stuck)
      payments.checkoutSnapshots.set(o.sessionId, { ...paid(o), outcome: "unpaid" });
    const newer = await pending(60);
    payments.checkoutSnapshots.set(newer.sessionId, paid(newer));

    await run(); // the five oldest, all still in flight
    expect((await orderState(newer.orderId))?.payment_status).toBe("pending");
    await run(new Date(NOW.getTime() + 5 * 60_000)); // the newer one's turn
    expect((await orderState(newer.orderId))?.payment_status).toBe("paid");
  });

  it("tells the desk when checking keeps failing hours after a checkout", async () => {
    await pending(4 * 60); // no snapshot: the processor cannot answer about it
    await run();
    expect(mail.sent.map((m) => m.subject)).toEqual([
      "Checking unfinished payments with Stripe is failing (1 waiting)",
    ]);
  });

  it("counts a session that will not settle its order as failing", async () => {
    const o = await pending(4 * 60);
    payments.checkoutSnapshots.set(o.sessionId, { ...paid(o), amountFils: 1 });
    await run();
    expect(mail.sent.map((m) => m.subject)).toEqual([
      "Checking unfinished payments with Stripe is failing (1 waiting)",
    ]);
  });

  it("closes the desk alert a day after the last rescue", async () => {
    const o = await pending(60);
    payments.checkoutSnapshots.set(o.sessionId, paid(o));
    await run();
    const dayLater = new Date(NOW.getTime() + 25 * 60 * 60_000);
    expect(await run(dayLater)).toMatchObject({ deskAlert: { resolved: 1 } });
  });
});
