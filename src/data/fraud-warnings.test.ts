import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import { orderHasDispute } from "./disputes";
import {
  linkFraudWarningsAtSettlement,
  listFraudWarningsForDesk,
  recordFraudWarning,
} from "./fraud-warnings";
import { issueDueRefunds } from "./refund-issuer";
import { purgeExpiredPersonalData } from "./retention";
import { MockPaymentProvider } from "@/domain/payments/mock-provider";
import { resetAuditSink, setAuditSink } from "@/lib/audit";
import type { FraudWarningEvent } from "@/domain/payments/provider";

/**
 * Early fraud warnings (audit s104 PAY-4; founder: refund automatically and
 * tell the desk). A paid order whose sessions are all two hours or more away
 * is cancelled and refunded in full, with no customer email; anything less
 * clear goes to a person; the desk hears about every one; and the order can
 * no longer be moved online.
 */

let db: PGlite;
let runner: QueryRunner;
let n = 0;
const HOUR = 60 * 60_000;
const NOW = new Date("2027-03-01T12:00:00Z");
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);

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
  readonly intent: string;
}

/** A paid order with one session starting `startsInHours` from NOW (null: no time yet). */
async function seed(
  startsInHours: number | null,
  over: { paymentStatus?: string; status?: string; createdAt?: Date } = {},
): Promise<Seeded> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`fraud${n}@example.com`],
  );
  const intent = `pi_f_${n}`;
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_payment_intent_id, created_at, updated_at)
     values ($1, 'single', 'ai-foundations', 129900, $2, $3, $4, $4) returning id`,
    [customer.rows[0]!.id, over.paymentStatus ?? "paid", intent, over.createdAt ?? NOW],
  );
  const orderId = order.rows[0]!.id;
  // Sessions a week apart per seed, so none overlap.
  const start = startsInHours === null ? null : at(startsInHours + n * 24 * 7);
  const end = start ? new Date(start.getTime() + HOUR) : null;
  const status = over.status ?? (start ? "confirmed" : "awaiting_schedule");
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, customer_timezone,
                           scheduled_start, scheduled_end, meeting_url)
     values ($1, 'ai-foundations', 1, $2, 'Asia/Dubai', $3, $4, $5) returning id`,
    [orderId, status, start, end, start ? "https://teams.example/join" : null],
  );
  return { orderId, bookingId: booking.rows[0]!.id, intent };
}

/** As seed, but the session starts exactly `hours` from NOW (no weekly spacing). */
async function seedAt(hours: number): Promise<Seeded> {
  const seeded = await seed(0);
  const start = at(hours);
  await db.query(`update bookings set scheduled_start = $2, scheduled_end = $3 where id = $1`, [
    seeded.bookingId,
    start,
    new Date(start.getTime() + HOUR),
  ]);
  return seeded;
}

const warning = (intent: string | null, over: Partial<FraudWarningEvent> = {}) => {
  n += 1;
  return {
    kind: "fraud_warning" as const,
    eventId: `evt_fw_${n}`,
    type: "radar.early_fraud_warning.created",
    occurredAt: NOW,
    ignorable: false as const,
    providerWarningId: `issfr_${n}`,
    paymentIntentId: intent,
    fraudType: "made_with_stolen_card",
    actionable: true,
    ...over,
  };
};

const tx = <T>(work: (r: QueryRunner) => Promise<T>) =>
  db.transaction((t) => work(t as unknown as QueryRunner));

const bookingStatus = async (id: string) =>
  (await db.query<{ status: string }>(`select status from bookings where id = $1`, [id])).rows[0]
    ?.status;

const refundsFor = async (orderId: string) =>
  (
    await db.query<{ origin: string; amount_fils: string; status: string; currency: string }>(
      `select origin, amount_fils::text, status, currency from refunds where order_id = $1`,
      [orderId],
    )
  ).rows;

const emailsFor = async (bookingId: string) =>
  (
    await db.query<{ template_key: string }>(
      `select template_key from communication_log where booking_id = $1`,
      [bookingId],
    )
  ).rows.map((r) => r.template_key);

describe("a warning on a paid order with its session well ahead", () => {
  it("cancels the session, queues a full refund, and emails nobody", async () => {
    const s = await seed(72);
    const recorded = await tx((r) => recordFraudWarning(r, warning(s.intent), NOW));
    expect(recorded).toMatchObject({ outcome: "refund_queued", orderId: s.orderId, isNew: true });
    expect(recorded.cancelledBookings).toEqual([s.bookingId]);
    expect(await bookingStatus(s.bookingId)).toBe("cancelled");
    expect(await refundsFor(s.orderId)).toEqual([
      { origin: "fraud_warning", amount_fils: "129900", status: "due", currency: "AED" },
    ]);
    expect(await emailsFor(s.bookingId)).toEqual([]);
  });

  it("does the same for a paid booking still waiting for a time", async () => {
    const s = await seed(null);
    const recorded = await tx((r) => recordFraudWarning(r, warning(s.intent), NOW));
    expect(recorded.outcome).toBe("refund_queued");
    expect(await bookingStatus(s.bookingId)).toBe("cancelled");
  });

  it("acts once: the same warning delivered again changes nothing", async () => {
    const s = await seed(72);
    const event = warning(s.intent);
    await tx((r) => recordFraudWarning(r, event, NOW));
    const again = await tx((r) => recordFraudWarning(r, { ...event, eventId: "evt_other" }, NOW));
    expect(again).toMatchObject({ isNew: false, outcome: "refund_queued" });
    expect(await refundsFor(s.orderId)).toHaveLength(1);
  });
});

describe("the refund a warning queued", () => {
  it("is sent by the refund step, leaves the order refunded, and emails nobody", async () => {
    await db.query("delete from refunds where status in ('due', 'issuing')");
    const s = await seed(72);
    await tx((r) => recordFraudWarning(r, warning(s.intent), NOW));
    const provider = new MockPaymentProvider();
    // As a card refund usually ends; "pending" would leave the order paid until the event.
    provider.refundStatus = "succeeded";
    setAuditSink(() => undefined);
    const report = await issueDueRefunds({ provider, transaction: tx, clock: () => NOW });
    resetAuditSink();
    expect(report).toMatchObject({ claimed: 1, issued: 1 });
    const order = await db.query<{ payment_status: string }>(
      `select payment_status from orders where id = $1`,
      [s.orderId],
    );
    expect(order.rows[0]?.payment_status).toBe("refunded");
    expect(await emailsFor(s.bookingId)).toEqual([]);
  });
});

/*
  Review s104: an order stays "paid" until a refund succeeds, so without this
  a second full refund was queued, refused by Stripe, and a "refund by hand"
  alarm invited a person to refund twice.
*/
describe("money already on its way back, or a dispute already here", () => {
  it("leaves a refund made in the dashboard and still pending to the desk", async () => {
    const s = await seed(72);
    await db.query(
      `insert into refunds (order_id, origin, amount_fils, currency, status, provider_refund_id)
       values ($1, 'processor', 129900, 'AED', 'pending', $2)`,
      [s.orderId, `re_pending_${s.orderId}`],
    );
    const recorded = await tx((r) => recordFraudWarning(r, warning(s.intent), NOW));
    expect(recorded.outcome).toBe("desk_decides");
    expect(await bookingStatus(s.bookingId)).toBe("confirmed");
    expect((await refundsFor(s.orderId)).map((r) => r.origin)).toEqual(["processor"]);
  });

  it("leaves an order with a dispute already stored to the desk", async () => {
    const s = await seed(72);
    await db.query(
      `insert into payment_disputes (provider_dispute_id, order_id, payment_intent_id, amount_minor,
                                     currency, reason, status)
       values ($1, $2, $3, 129900, 'AED', 'fraudulent', 'warning_needs_response')`,
      [`dp_${s.orderId}`, s.orderId, s.intent],
    );
    expect((await tx((r) => recordFraudWarning(r, warning(s.intent), NOW))).outcome).toBe(
      "desk_decides",
    );
    expect(await refundsFor(s.orderId)).toEqual([]);
  });
});

describe("a warning that came before its payment was recorded", () => {
  it("is linked at settlement, for the desk to decide, and stops online moves", async () => {
    const s = await seed(72);
    await db.query(`update orders set stripe_payment_intent_id = null where id = $1`, [s.orderId]);
    expect((await tx((r) => recordFraudWarning(r, warning(s.intent), NOW))).outcome).toBe(
      "unknown_order",
    );
    expect(await orderHasDispute(runner, s.orderId)).toBe(false);

    expect(await tx((r) => linkFraudWarningsAtSettlement(r, s.orderId, s.intent))).toBe(1);
    const row = await db.query<{ outcome: string }>(
      `select outcome from fraud_warnings where order_id = $1`,
      [s.orderId],
    );
    expect(row.rows).toEqual([{ outcome: "desk_decides" }]);
    expect(await orderHasDispute(runner, s.orderId)).toBe(true);
    // Nothing automatic: the session stays until a person decides.
    expect(await bookingStatus(s.bookingId)).toBe("confirmed");
  });

  it("about a payment never ours, is deleted once the record period has passed", async () => {
    const event = warning("pi_never_ours");
    await tx((r) => recordFraudWarning(r, event, new Date("2017-06-01T00:00:00Z")));
    await tx((r) => purgeExpiredPersonalData(r, NOW));
    const left = await db.query(`select 1 from fraud_warnings where provider_warning_id = $1`, [
      event.providerWarningId,
    ]);
    expect(left.rows).toHaveLength(0);
  });
});

describe("a warning a person must decide", () => {
  it("leaves a session inside two hours alone", async () => {
    const s = await seedAt(1.5);
    const recorded = await tx((r) => recordFraudWarning(r, warning(s.intent), NOW));
    expect(recorded.outcome).toBe("desk_decides");
    expect(await bookingStatus(s.bookingId)).toBe("confirmed");
    expect(await refundsFor(s.orderId)).toEqual([]);
  });

  it("leaves a session already delivered alone", async () => {
    const s = await seedAt(-24);
    expect((await tx((r) => recordFraudWarning(r, warning(s.intent), NOW))).outcome).toBe(
      "desk_decides",
    );
    expect(await refundsFor(s.orderId)).toEqual([]);
  });

  it("leaves an order not paid in full, or a warning no longer actionable, alone", async () => {
    const partly = await seed(72, { paymentStatus: "partially_refunded" });
    expect((await tx((r) => recordFraudWarning(r, warning(partly.intent), NOW))).outcome).toBe(
      "desk_decides",
    );
    const quiet = await seed(72);
    const recorded = await tx((r) =>
      recordFraudWarning(r, warning(quiet.intent, { actionable: false }), NOW),
    );
    expect(recorded.outcome).toBe("desk_decides");
    expect(await bookingStatus(quiet.bookingId)).toBe("confirmed");
  });

  it("stores a warning for a payment that is not ours, and does nothing else", async () => {
    const recorded = await tx((r) => recordFraudWarning(r, warning("pi_not_ours"), NOW));
    expect(recorded).toMatchObject({ outcome: "unknown_order", orderId: null });
  });
});

describe("after a warning", () => {
  it("the order can no longer be moved or given a time online", async () => {
    const s = await seed(72);
    expect(await orderHasDispute(runner, s.orderId)).toBe(false);
    await tx((r) => recordFraudWarning(r, warning(s.intent), NOW));
    expect(await orderHasDispute(runner, s.orderId)).toBe(true);
  });

  it("the desk hears about a refund once, and about a decision until it is refunded", async () => {
    await db.query(`delete from refunds where origin = 'fraud_warning'`);
    await db.query(`delete from fraud_warnings`);
    const refunded = await seed(72);
    // A quarter of an hour away, clear of the other near sessions above.
    const decide = await seedAt(0.25);
    await tx((r) => recordFraudWarning(r, warning(refunded.intent), NOW));
    await tx((r) => recordFraudWarning(r, warning(decide.intent), NOW));

    const now = await listFraudWarningsForDesk(runner, at(1));
    expect(now.map((w) => w.outcome).toSorted()).toEqual(["desk_decides", "refund_queued"]);
    expect(now.find((w) => w.outcome === "desk_decides")).toMatchObject({
      orderId: decide.orderId,
      bookingId: decide.bookingId,
      grossAmountFils: 129900,
    });

    // A day on: the automatic refund has been told; the decision still waits.
    expect((await listFraudWarningsForDesk(runner, at(25))).map((w) => w.outcome)).toEqual([
      "desk_decides",
    ]);
    // Refunded in full by a person: closed.
    await db.query(`update orders set payment_status = 'refunded' where id = $1`, [decide.orderId]);
    expect(await listFraudWarningsForDesk(runner, at(26))).toEqual([]);
  });

  it("goes with its order when the order is deleted, so it never blocks the clean-up", async () => {
    // An old unpaid order: the retention job deletes it, and the warning must go with it.
    const old = await seed(null, { paymentStatus: "failed", createdAt: at(-24 * 60) });
    await tx((r) => recordFraudWarning(r, warning(old.intent), NOW));
    expect(
      (await db.query(`select 1 from fraud_warnings where order_id = $1`, [old.orderId])).rows,
    ).toHaveLength(1);

    await tx((r) => purgeExpiredPersonalData(r, NOW));

    expect((await db.query(`select 1 from orders where id = $1`, [old.orderId])).rows).toHaveLength(
      0,
    );
    expect(
      (await db.query(`select 1 from fraud_warnings where order_id = $1`, [old.orderId])).rows,
    ).toHaveLength(0);
  });

  it("and so does the refund it queued, before the warning itself", async () => {
    const s = await seed(72);
    await tx((r) => recordFraudWarning(r, warning(s.intent), NOW));
    await db.query(`update orders set payment_status = 'failed', created_at = $2 where id = $1`, [
      s.orderId,
      at(-24 * 60),
    ]);
    await tx((r) => purgeExpiredPersonalData(r, NOW));
    expect((await db.query(`select 1 from orders where id = $1`, [s.orderId])).rows).toHaveLength(
      0,
    );
  });
});
