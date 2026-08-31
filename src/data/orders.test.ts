import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  attachCheckoutSession,
  attributionIdForSession,
  leadBelongsTogether,
  persistPendingOrder,
  SlotHoldNoLongerLiveError,
} from "./orders";
import { holdSlot } from "./slot-holds";
import type { QueryRunner } from "./db";
import { createOrder } from "@/domain/booking/order";
import { AED } from "@/lib/money";

/**
 * An order, its booking and its claim on a time - written as one unit.
 *
 * The property under test is atomicity. An order without its booking is a
 * customer charged for a session that does not exist; a booking whose hold was
 * never claimed is a session nothing protects on the calendar. Both are
 * unrecoverable by hand once real money is involved.
 *
 * (The migration loader uses the PGlite multi-statement SQL entry point. It is
 * a SQL executor, unrelated to child_process despite the name an editor
 * security reminder matches on.)
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const NOW = new Date("2027-09-01T09:00:00Z");
const SLOT_START = new Date("2027-09-10T14:00:00Z");
const SLOT_END = new Date("2027-09-10T15:30:00Z");

let db: PGlite;
let runner: QueryRunner;

beforeAll(async () => {
  db = await PGlite.create();
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  runner = db as unknown as QueryRunner;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

async function makeCustomerAndIntake(email: string) {
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [email],
  );
  const customerId = customer.rows[0]?.id ?? "";

  const intake = await db.query<{ id: string }>(
    `insert into intakes (customer_id, primary_goal) values ($1, 'Ship faster') returning id`,
    [customerId],
  );
  return { customerId, intakeId: intake.rows[0]?.id ?? "" };
}

const order = (customerId: string, intakeId: string, id = randomUUID()) =>
  createOrder({
    id,
    customerId,
    orderType: "single",
    sessionSlug: "ai-foundations",
    grossAmountFils: 129900,
    currency: AED,
    taxRateBasisPoints: 0,
    intakeId,
    now: NOW,
  });

async function liveHold(startIso: string) {
  const start = new Date(startIso);
  const outcome = await holdSlot(
    {
      slotStart: start,
      slotEnd: new Date(start.getTime() + 90 * 60_000),
      expiresAt: new Date(Date.now() + 15 * 60_000),
    },
    (work) => work(runner),
  );
  if (!outcome.ok) throw new Error("test setup could not take a hold");
  return outcome.hold.id;
}

describe("leadBelongsTogether", () => {
  it("accepts an intake that really belongs to the customer", async () => {
    const { customerId, intakeId } = await makeCustomerAndIntake("belongs@example.com");
    expect(await leadBelongsTogether(runner, customerId, intakeId)).toBe(true);
  });

  /*
    THE check that makes the lead cookie hold up. A forged pair has to get
    both ids right AND their relationship, rather than one lucky guess.
  */
  it("refuses an intake belonging to somebody else", async () => {
    const mine = await makeCustomerAndIntake("mine@example.com");
    const theirs = await makeCustomerAndIntake("theirs@example.com");

    expect(await leadBelongsTogether(runner, mine.customerId, theirs.intakeId)).toBe(false);
  });

  it("refuses ids that do not exist at all", async () => {
    expect(await leadBelongsTogether(runner, randomUUID(), randomUUID())).toBe(false);
  });
});

describe("persistPendingOrder", () => {
  it("writes the order, its booking and the link from the hold, together", async () => {
    const { customerId, intakeId } = await makeCustomerAndIntake("together@example.com");
    const holdId = await liveHold("2027-09-10T14:00:00Z");
    const o = order(customerId, intakeId);

    const result = await persistPendingOrder(runner, {
      order: o,
      sessionSlug: "ai-foundations",
      slotStart: SLOT_START,
      slotEnd: SLOT_END,
      customerTimezone: "Asia/Dubai",
      slotHoldId: holdId,
    });

    const stored = await db.query<{ payment_status: string; gross_amount_fils: string }>(
      "select payment_status, gross_amount_fils from orders where id = $1",
      [result.orderId],
    );
    expect(stored.rows[0]?.payment_status).toBe("pending");
    expect(Number(stored.rows[0]?.gross_amount_fils)).toBe(129900);

    const booking = await db.query<{ status: string; customer_timezone: string }>(
      "select status, customer_timezone from bookings where order_id = $1",
      [result.orderId],
    );
    expect(booking.rows[0]?.status).toBe("awaiting_schedule");
    expect(booking.rows[0]?.customer_timezone).toBe("Asia/Dubai");

    const hold = await db.query<{ order_id: string }>(
      "select order_id from slot_holds where id = $1",
      [holdId],
    );
    expect(hold.rows[0]?.order_id).toBe(result.orderId);
  });

  /*
    An order that begins life already paid is one nobody verified a webhook
    for. There is no code path that writes anything else, and this is what
    stops one appearing later.
  */
  it("always writes the order as pending", async () => {
    const { customerId, intakeId } = await makeCustomerAndIntake("pending@example.com");
    const holdId = await liveHold("2027-09-11T14:00:00Z");

    const result = await persistPendingOrder(runner, {
      order: order(customerId, intakeId),
      sessionSlug: "ai-foundations",
      slotStart: SLOT_START,
      slotEnd: SLOT_END,
      customerTimezone: "Asia/Dubai",
      slotHoldId: holdId,
    });

    const stored = await db.query<{ payment_status: string }>(
      "select payment_status from orders where id = $1",
      [result.orderId],
    );
    expect(stored.rows[0]?.payment_status).toBe("pending");
  });

  /*
    A hold that expired while the customer was deciding must not be silently
    adopted. Refusing means the customer is told to pick again, instead of
    getting an order for a time somebody else may already hold.
  */
  it("refuses to adopt a hold that is no longer live", async () => {
    const { customerId, intakeId } = await makeCustomerAndIntake("expired@example.com");
    const holdId = await liveHold("2027-09-12T14:00:00Z");
    await db.query("update slot_holds set status = 'expired' where id = $1", [holdId]);

    await expect(
      persistPendingOrder(runner, {
        order: order(customerId, intakeId),
        sessionSlug: "ai-foundations",
        slotStart: SLOT_START,
        slotEnd: SLOT_END,
        customerTimezone: "Asia/Dubai",
        slotHoldId: holdId,
      }),
    ).rejects.toThrow(SlotHoldNoLongerLiveError);
  });

  /*
    CHANGED 2026-08-31. This asserted the booking was written WITH its times.
    It is now born with none, deliberately: the chosen slot already exists once
    on the slot hold, and copying it onto the booking before anybody has paid
    creates a second place for the same fact to live and disagree from. The
    times are attached at settlement, from the hold that was converted.
  */
  it("writes the booking with no times yet, because nobody has paid", async () => {
    const { customerId, intakeId } = await makeCustomerAndIntake("times@example.com");
    const holdId = await liveHold("2027-09-13T14:00:00Z");

    const result = await persistPendingOrder(runner, {
      order: order(customerId, intakeId),
      sessionSlug: "ai-foundations",
      slotStart: SLOT_START,
      slotEnd: SLOT_END,
      customerTimezone: "Asia/Dubai",
      slotHoldId: holdId,
    });

    const booking = await db.query<{
      scheduled_start: Date | null;
      scheduled_end: Date | null;
      status: string;
      sequence: number;
    }>(
      "select scheduled_start, scheduled_end, status, sequence from bookings where order_id = $1",
      [result.orderId],
    );

    expect(booking.rows[0]?.status).toBe("awaiting_schedule");
    expect(booking.rows[0]?.scheduled_start).toBeNull();
    expect(booking.rows[0]?.scheduled_end).toBeNull();
    // Built by createBooking, which is where the sequence rule lives.
    expect(booking.rows[0]?.sequence).toBe(1);
  });
});

describe("attributionIdForSession", () => {
  it("finds the attribution for a browser that has one", async () => {
    await db.query(
      "insert into attributions (landing_page, anonymous_session_id) values ('/training', $1)",
      ["ats-known"],
    );

    expect(await attributionIdForSession(runner, "ats-known")).not.toBeNull();
  });

  /*
    Attribution is a reporting nicety. A missing row costs us a line in a
    report; it must never cost somebody their booking, so both of these return
    null rather than throwing.
  */
  it("returns null rather than failing when there is no cookie", async () => {
    expect(await attributionIdForSession(runner, null)).toBeNull();
  });

  it("returns null for a browser we have never seen", async () => {
    expect(await attributionIdForSession(runner, "ats-never-seen")).toBeNull();
  });
});

describe("attachCheckoutSession", () => {
  it("records which Stripe session belongs to the order", async () => {
    const { customerId, intakeId } = await makeCustomerAndIntake("attach@example.com");
    const holdId = await liveHold("2027-09-14T14:00:00Z");
    const result = await persistPendingOrder(runner, {
      order: order(customerId, intakeId),
      sessionSlug: "ai-foundations",
      slotStart: SLOT_START,
      slotEnd: SLOT_END,
      customerTimezone: "Asia/Dubai",
      slotHoldId: holdId,
    });

    await attachCheckoutSession(runner, result.orderId, "cs_test_abc");

    const stored = await db.query<{ stripe_checkout_session_id: string }>(
      "select stripe_checkout_session_id from orders where id = $1",
      [result.orderId],
    );
    expect(stored.rows[0]?.stripe_checkout_session_id).toBe("cs_test_abc");
  });

  /*
    The column is unique, so a replayed checkout cannot attach the same Stripe
    session to a second order. Attempted rather than assumed.
  */
  it("refuses to attach one Stripe session to two orders", async () => {
    const { customerId, intakeId } = await makeCustomerAndIntake("dupe@example.com");

    const first = await persistPendingOrder(runner, {
      order: order(customerId, intakeId),
      sessionSlug: "ai-foundations",
      slotStart: SLOT_START,
      slotEnd: SLOT_END,
      customerTimezone: "Asia/Dubai",
      slotHoldId: await liveHold("2027-09-15T14:00:00Z"),
    });
    const second = await persistPendingOrder(runner, {
      order: order(customerId, intakeId),
      sessionSlug: "ai-foundations",
      slotStart: SLOT_START,
      slotEnd: SLOT_END,
      customerTimezone: "Asia/Dubai",
      slotHoldId: await liveHold("2027-09-16T14:00:00Z"),
    });

    await attachCheckoutSession(runner, first.orderId, "cs_shared");
    await expect(attachCheckoutSession(runner, second.orderId, "cs_shared")).rejects.toThrow();
  });
});
