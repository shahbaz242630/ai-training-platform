import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { releaseFailedOrder, settlePaidOrder } from "./settlement";
import { claimWebhookEvent, markWebhookProcessed } from "./webhook-events";
import { persistPendingOrder } from "./orders";
import { holdSlot, listLiveHolds } from "./slot-holds";
import type { QueryRunner } from "./db";
import { createOrder } from "@/domain/booking/order";
import { AED } from "@/lib/money";

/**
 * What a verified payment does to an order, its booking and its slot.
 *
 * This is the code that decides whether somebody who paid actually has a
 * session. The cases worth the most here are the awkward ones: a duplicate
 * delivery, and money arriving after the slot has gone.
 *
 * (The migration loader uses the PGlite multi-statement SQL entry point - a
 * SQL executor, unrelated to child_process despite the name an editor security
 * reminder matches on.)
 */

const NOW = new Date("2027-10-01T09:00:00Z");
const SLOT_START = new Date("2027-10-20T14:00:00Z");
const SLOT_END = new Date("2027-10-20T15:30:00Z");

let db: PGlite;
let runner: QueryRunner;

beforeAll(async () => {
  db = await PGlite.create();
  for (const file of readdirSync(join(process.cwd(), "supabase", "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(process.cwd(), "supabase", "migrations", file), "utf8"));
  }
  runner = db as unknown as QueryRunner;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

let slotCounter = 0;

/** A pending order with its booking and a live hold - the state checkout leaves behind. */
async function pendingOrder(email: string) {
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [email],
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
      expiresAt: new Date(NOW.getTime() + 15 * 60_000),
    },
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
    intakeId: intake.rows[0]?.id ?? "",
    now: NOW,
  });

  await persistPendingOrder(runner, {
    order,
    sessionSlug: "ai-foundations",
    slotStart: SLOT_START,
    slotEnd: SLOT_END,
    customerTimezone: "Asia/Dubai",
    slotHoldId: held.hold.id,
  });

  return { orderId: order.id, slotHoldId: held.hold.id };
}

const statusOf = async (orderId: string) => {
  const o = await db.query<{ payment_status: string }>(
    "select payment_status from orders where id = $1",
    [orderId],
  );
  const b = await db.query<{ status: string }>("select status from bookings where order_id = $1", [
    orderId,
  ]);
  return { order: o.rows[0]?.payment_status, booking: b.rows[0]?.status };
};

const holdStatus = (id: string) =>
  db
    .query<{ status: string }>("select status from slot_holds where id = $1", [id])
    .then((r) => r.rows[0]?.status);

describe("settlePaidOrder", () => {
  it("marks the order paid, converts the hold and schedules the booking", async () => {
    const { orderId, slotHoldId } = await pendingOrder("settle@example.com");

    const outcome = await settlePaidOrder(runner, { orderId, slotHoldId, now: NOW });

    expect(outcome).toBe("settled");
    expect(await statusOf(orderId)).toEqual({ order: "paid", booking: "scheduled" });
    expect(await holdStatus(slotHoldId)).toBe("converted");
  });

  /*
    The booking does NOT reach `confirmed` here. There is no calendar event and
    no joining link yet, and a booking that says confirmed without one is what
    produces a confirmation email with nowhere to click.
  */
  it("stops at scheduled rather than confirming without a joining link", async () => {
    const { orderId, slotHoldId } = await pendingOrder("scheduled-only@example.com");
    await settlePaidOrder(runner, { orderId, slotHoldId, now: NOW });

    expect((await statusOf(orderId)).booking).toBe("scheduled");
  });

  /*
    THE idempotency case. Stripe retries, and a second delivery must not
    produce a second anything.
  */
  it("does nothing on a second delivery for the same order", async () => {
    const { orderId, slotHoldId } = await pendingOrder("twice@example.com");

    const first = await settlePaidOrder(runner, { orderId, slotHoldId, now: NOW });
    const second = await settlePaidOrder(runner, { orderId, slotHoldId, now: NOW });

    expect(first).toBe("settled");
    expect(second).toBe("already_settled");
    expect(await statusOf(orderId)).toEqual({ order: "paid", booking: "scheduled" });
  });

  /*
    THE ONE THAT NEEDS A HUMAN. A delayed payment method can land hours after
    the hold expired. The money is ours, so the order MUST be paid - leaving it
    pending is what produces a second charge - and the booking waits to be
    rescheduled by hand.
  */
  it("keeps the order paid when the slot has already gone", async () => {
    const { orderId, slotHoldId } = await pendingOrder("late@example.com");
    await db.query("update slot_holds set status = 'expired' where id = $1", [slotHoldId]);

    const outcome = await settlePaidOrder(runner, { orderId, slotHoldId, now: NOW });

    expect(outcome).toBe("paid_without_slot");
    expect(await statusOf(orderId)).toEqual({ order: "paid", booking: "awaiting_schedule" });
  });

  // Same case, reached the other way: the hold is still `held` but has run out.
  it("refuses a hold that expired even though nothing swept it", async () => {
    const { orderId, slotHoldId } = await pendingOrder("stale@example.com");
    await db.query("update slot_holds set expires_at = $2 where id = $1", [
      slotHoldId,
      new Date(NOW.getTime() - 60_000),
    ]);

    expect(await settlePaidOrder(runner, { orderId, slotHoldId, now: NOW })).toBe(
      "paid_without_slot",
    );
    expect((await statusOf(orderId)).order).toBe("paid");
  });

  /*
    A hold belonging to a different order must never be converted by this one.
    That would take somebody else time and give it to this customer.
  */
  it("refuses a hold that belongs to another order", async () => {
    const mine = await pendingOrder("mine-hold@example.com");
    const theirs = await pendingOrder("their-hold@example.com");

    const outcome = await settlePaidOrder(runner, {
      orderId: mine.orderId,
      slotHoldId: theirs.slotHoldId,
      now: NOW,
    });

    expect(outcome).toBe("paid_without_slot");
    expect(await holdStatus(theirs.slotHoldId)).toBe("held");
  });

  it("reports an order it has never heard of", async () => {
    expect(
      await settlePaidOrder(runner, { orderId: randomUUID(), slotHoldId: null, now: NOW }),
    ).toBe("unknown_order");
  });

  /*
    A success for a refunded order is a genuine anomaly. It must be refused -
    but as an answer, not an exception, or the processor retries something
    that can never become legal.
  */
  it("refuses a success for a refunded order without throwing", async () => {
    const { orderId, slotHoldId } = await pendingOrder("refunded@example.com");
    await db.query("update orders set payment_status = 'refunded' where id = $1", [orderId]);

    expect(await settlePaidOrder(runner, { orderId, slotHoldId, now: NOW })).toBe("refused");
  });
});

describe("releaseFailedOrder", () => {
  it("marks the order failed and gives the slot back", async () => {
    const { orderId, slotHoldId } = await pendingOrder("failed@example.com");

    const outcome = await releaseFailedOrder(runner, { orderId, slotHoldId, now: NOW });

    expect(outcome).toBe("released");
    expect((await statusOf(orderId)).order).toBe("failed");
    expect(await holdStatus(slotHoldId)).toBe("released");
  });

  /*
    The booking is deliberately NOT cancelled. `failed -> paid` is a permitted
    move because a declined attempt can be followed by a successful one, and a
    cancelled booking could never then be scheduled.
  */
  it("leaves the booking able to be scheduled if payment later succeeds", async () => {
    const { orderId, slotHoldId } = await pendingOrder("retry@example.com");
    await releaseFailedOrder(runner, { orderId, slotHoldId, now: NOW });

    expect((await statusOf(orderId)).booking).toBe("awaiting_schedule");

    // And the later success is accepted rather than refused.
    const outcome = await settlePaidOrder(runner, { orderId, slotHoldId: null, now: NOW });
    expect(outcome).toBe("paid_without_slot");
    expect((await statusOf(orderId)).order).toBe("paid");
  });

  it("is a no-op on a second failure delivery", async () => {
    const { orderId, slotHoldId } = await pendingOrder("failed-twice@example.com");

    await releaseFailedOrder(runner, { orderId, slotHoldId, now: NOW });
    expect(await releaseFailedOrder(runner, { orderId, slotHoldId, now: NOW })).toBe("released");
    expect((await statusOf(orderId)).order).toBe("failed");
  });

  /*
    A failure event for an order already paid is anomalous. It must not undo a
    payment, and it must not throw its way into an endless retry.
  */
  it("refuses to fail an order that is already paid", async () => {
    const { orderId, slotHoldId } = await pendingOrder("already-paid@example.com");
    await settlePaidOrder(runner, { orderId, slotHoldId, now: NOW });

    expect(await releaseFailedOrder(runner, { orderId, slotHoldId, now: NOW })).toBe("refused");
    expect(await statusOf(orderId)).toEqual({ order: "paid", booking: "scheduled" });
    expect(await holdStatus(slotHoldId)).toBe("converted");
  });
});

describe("the webhook event ledger", () => {
  it("claims an event once and refuses the duplicate", async () => {
    const id = `evt_${randomUUID()}`;

    expect(
      (await claimWebhookEvent(runner, id, "checkout.session.completed")).isFirstDelivery,
    ).toBe(true);
    expect(
      (await claimWebhookEvent(runner, id, "checkout.session.completed")).isFirstDelivery,
    ).toBe(false);
  });

  it("treats two different events as two claims", async () => {
    const a = await claimWebhookEvent(runner, `evt_${randomUUID()}`, "checkout.session.completed");
    const b = await claimWebhookEvent(runner, `evt_${randomUUID()}`, "checkout.session.completed");

    expect(a.isFirstDelivery).toBe(true);
    expect(b.isFirstDelivery).toBe(true);
  });

  /*
    A claim with no processed_at is a delivery we accepted and then failed to
    finish. Somebody investigating needs to be able to find exactly those.
  */
  it("records when a delivery was finished, separately from when it was claimed", async () => {
    const id = `evt_${randomUUID()}`;
    await claimWebhookEvent(runner, id, "checkout.session.completed");

    const before = await db.query<{ processed_at: Date | null }>(
      "select processed_at from webhook_events where external_event_id = $1",
      [id],
    );
    expect(before.rows[0]?.processed_at).toBeNull();

    await markWebhookProcessed(runner, id);

    const after = await db.query<{ processed_at: Date | null }>(
      "select processed_at from webhook_events where external_event_id = $1",
      [id],
    );
    expect(after.rows[0]?.processed_at).not.toBeNull();
  });

  // No payment details, no customer. Nothing worth reading if it ever leaked.
  it("stores nothing but the delivery itself", async () => {
    const columns = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'webhook_events'`,
    );
    const names = columns.rows.map((r) => r.column_name).sort();
    expect(names).toEqual([
      "event_type",
      "external_event_id",
      "id",
      "processed_at",
      "provider",
      "received_at",
    ]);
  });
});

/*
  The end-to-end proof of the double-booking fix, at the layer a customer
  actually meets it: settle a payment, then try to take the same time again.
*/
describe("a settled booking cannot be sold twice", () => {
  it("refuses a new hold on a slot whose payment has settled", async () => {
    const { orderId, slotHoldId } = await pendingOrder("double-book@example.com");

    const start = await db
      .query<{ slot_start: Date; slot_end: Date }>(
        "select slot_start, slot_end from slot_holds where id = $1",
        [slotHoldId],
      )
      .then((r) => r.rows[0]);

    expect(await settlePaidOrder(runner, { orderId, slotHoldId, now: NOW })).toBe("settled");

    // Somebody else tries for the same time. The database must refuse.
    await expect(
      db.query(`insert into slot_holds (slot_start, slot_end, expires_at) values ($1, $2, $3)`, [
        start?.slot_start,
        start?.slot_end,
        new Date(NOW.getTime() + 35 * 60_000),
      ]),
    ).rejects.toThrow();
  });

  it("no longer offers that slot in availability", async () => {
    const { orderId, slotHoldId } = await pendingOrder("gone-from-list@example.com");
    const start = await db
      .query<{ slot_start: Date }>("select slot_start from slot_holds where id = $1", [slotHoldId])
      .then((r) => r.rows[0]?.slot_start);

    await settlePaidOrder(runner, { orderId, slotHoldId, now: NOW });

    const holds = await listLiveHolds(
      runner,
      { from: new Date("2027-10-01T00:00:00Z"), to: new Date("2027-12-31T00:00:00Z") },
      // Well past the original hold expiry - a paid slot must not reappear.
      new Date(NOW.getTime() + 48 * 60 * 60_000),
    );

    expect(holds.some((h) => h.slotStart.getTime() === start?.getTime())).toBe(true);
  });
});
