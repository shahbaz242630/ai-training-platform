import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import { listPaidButUnscheduled } from "./audit-events";
import { cancelOpenBooking } from "./booking-cancellation";
import { scheduleWaitingBooking } from "./choose-time";
import {
  linkUnlinkedDisputes,
  listDisputesForDesk,
  linkDisputesAtSettlement,
  orderHasDispute,
  ordersWithDisputeWork,
} from "./disputes";
import { loadBookingForManage, moveBooking } from "./reschedule";
import { purgeExpiredPersonalData } from "./retention";

/**
 * What a dispute does to the rest of the booking flow: the customer cannot
 * move or choose a time while it is not over, the desk sees the ones it must
 * answer with the evidence on record, a dispute that came before its order's
 * payment is linked later, and the paid-with-no-time list leaves disputed
 * orders to the dispute alert.
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

/** A paid order and its booking: confirmed at its own time, or waiting with none. */
async function seed(
  over: {
    status?: "confirmed" | "awaiting_schedule";
    paymentStatus?: string;
    createdAt?: Date;
  } = {},
): Promise<Seeded> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`disputes${n}@example.com`],
  );
  const intent = `pi_d_${n}`;
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_payment_intent_id, created_at, updated_at)
     values ($1, 'single', 'ai-foundations', 129900, $2, $3, $4, $4) returning id`,
    [customer.rows[0]!.id, over.paymentStatus ?? "paid", intent, over.createdAt ?? NOW],
  );
  const orderId = order.rows[0]!.id;
  const status = over.status ?? "confirmed";
  const start = status === "confirmed" ? at(72 + n * 24) : null;
  const end = start ? new Date(start.getTime() + HOUR) : null;
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, customer_timezone,
                           scheduled_start, scheduled_end, meeting_url)
     values ($1, 'ai-foundations', 1, $2, 'Asia/Dubai', $3, $4, $5) returning id`,
    [orderId, status, start, end, start ? "https://teams.example/join" : null],
  );
  if (start && end) {
    await db.query(
      `insert into slot_holds (slot_start, slot_end, order_id, expires_at, status)
       values ($1, $2, $3, $1, 'converted')`,
      [start, end, orderId],
    );
  }
  return { orderId, bookingId: booking.rows[0]!.id, intent };
}

async function addDispute(
  orderId: string | null,
  over: { status?: string; reason?: string; intent?: string; dueBy?: Date | null } = {},
): Promise<string> {
  n += 1;
  const row = await db.query<{ id: string }>(
    `insert into payment_disputes (provider_dispute_id, order_id, payment_intent_id, amount_minor,
                                   currency, reason, status, evidence_due_by)
     values ($1, $2, $3, 129900, 'AED', $4, $5, $6) returning id`,
    [
      `dp_${n}`,
      orderId,
      over.intent ?? null,
      over.reason ?? "product_not_received",
      over.status ?? "needs_response",
      over.dueBy === undefined ? at(24 * 7) : over.dueBy,
    ],
  );
  return row.rows[0]!.id;
}

describe("while a dispute is not over", () => {
  it("the customer cannot move the session, not even once the dispute is won", async () => {
    const s = await seed();
    const disputeId = await addDispute(s.orderId);
    const newSlot = { start: at(24 * 400), end: at(24 * 400 + 1) };

    expect(await moveBooking(runner, { bookingId: s.bookingId, newSlot, now: NOW })).toEqual({
      kind: "refused",
      reason: "disputed",
    });
    expect((await loadBookingForManage(runner, s.bookingId))?.disputed).toBe(true);

    // After a stolen-card dispute the person with the link may not be the cardholder: a person rebooks.
    await db.query(`update payment_disputes set status = 'won' where id = $1`, [disputeId]);
    expect(await orderHasDispute(runner, s.orderId)).toBe(true);
    expect(await moveBooking(runner, { bookingId: s.bookingId, newSlot, now: NOW })).toEqual({
      kind: "refused",
      reason: "disputed",
    });
  });

  it("a paid booking with no time cannot be given one from a link", async () => {
    const s = await seed({ status: "awaiting_schedule" });
    await addDispute(s.orderId, { status: "warning_needs_response" });

    const outcome = await scheduleWaitingBooking(runner, {
      bookingId: s.bookingId,
      newSlot: { start: at(24 * 500), end: at(24 * 500 + 1) },
      now: NOW,
    });

    expect(outcome).toEqual({ kind: "refused", reason: "disputed" });
  });

  it("an order never disputed is not frozen", async () => {
    const s = await seed();
    expect(await orderHasDispute(runner, s.orderId)).toBe(false);
  });
});

describe("the disputes the desk must answer", () => {
  it("lists one waiting for a response, with the terms ticked and the emails sent", async () => {
    const s = await seed();
    await db.query(
      `insert into booking_consents (order_id, terms_version, key_terms, agreement_text,
                                     within_cancellation_period, express_request, text_sha256,
                                     accepted_at)
       values ($1, '2026-10-15', 'No refunds', 'I agree', false, false, $2, $3)`,
      [s.orderId, "a".repeat(64), at(-48)],
    );
    await db.query(
      `insert into communication_log (booking_id, channel, template_key, status, sent_at)
       values ($1, 'email', 'booking_confirmation', 'sent', $2)`,
      [s.bookingId, at(-47)],
    );
    const id = await addDispute(s.orderId);

    const listed = (await listDisputesForDesk(runner, NOW)).find((d) => d.id === id);

    expect(listed).toMatchObject({
      orderId: s.orderId,
      bookingId: s.bookingId,
      bookingStatus: "confirmed",
      termsVersion: "2026-10-15",
      termsAcceptedAt: at(-48),
      emailsSent: [{ templateKey: "booking_confirmation", sentAt: at(-47) }],
    });
  });

  it("lists an unknown status and a dispute on a payment we cannot find; not one under review or over", async () => {
    const s = await seed();
    const unknown = await addDispute(s.orderId, { status: "brand_new_status" });
    const orphan = await addDispute(null, { status: "under_review", intent: "pi_unknown" });
    const reviewing = await addDispute(s.orderId, { status: "under_review" });
    const won = await addDispute(s.orderId, { status: "won" });

    const ids = (await listDisputesForDesk(runner, NOW)).map((d) => d.id);

    expect(ids).toContain(unknown);
    expect(ids).toContain(orphan);
    expect(ids).not.toContain(reviewing);
    expect(ids).not.toContain(won);
  });
});

describe("a dispute that came before its order's payment", () => {
  it("is linked once the order has the payment, and its work is then found", async () => {
    const s = await seed();
    await addDispute(null, { status: "needs_response", reason: "fraudulent", intent: s.intent });

    expect(await linkUnlinkedDisputes(runner, NOW)).toEqual([s.orderId]);
    expect(await ordersWithDisputeWork(runner, NOW)).toContain(s.orderId);
  });

  it("an ordinary chargeback leaves no work: its session stays", async () => {
    const s = await seed();
    await addDispute(s.orderId, { status: "needs_response", reason: "product_not_received" });
    expect(await ordersWithDisputeWork(runner, NOW)).not.toContain(s.orderId);
  });
});

describe("a dispute that arrived before the payment, at settlement", () => {
  it("is linked and a stolen-card session cancelled in the settlement itself", async () => {
    const s = await seed();
    await addDispute(null, { status: "needs_response", reason: "fraudulent", intent: s.intent });

    const cancelled = await linkDisputesAtSettlement(runner, s.orderId, s.intent, NOW);

    expect(cancelled).toEqual([s.bookingId]);
  });
});

describe("dispute outcomes the desk must follow up", () => {
  it("lists a lost dispute, and a won one only when it had cancelled a session, for a week", async () => {
    const lost = await seed();
    const lostId = await addDispute(lost.orderId, { status: "lost" });
    const wonPlain = await seed();
    const wonPlainId = await addDispute(wonPlain.orderId, { status: "won" });
    const wonCancelled = await seed();
    const wonCancelledId = await addDispute(wonCancelled.orderId, {
      status: "won",
      reason: "fraudulent",
    });
    await db.query(
      `insert into audit_events (action, actor_kind, subject, metadata, occurred_at)
       values ('booking.cancelled', 'provider', $1, '{"cause":"dispute_fraud"}', $2)`,
      [`booking:${wonCancelled.bookingId}`, NOW],
    );

    const now = new Date();
    const listed = await listDisputesForDesk(runner, now);
    const byId = new Map(listed.map((d) => [d.id, d]));

    expect(byId.get(lostId)?.kind).toBe("outcome");
    expect(byId.get(wonCancelledId)).toMatchObject({
      kind: "outcome",
      sessionCancelledByDispute: true,
    });
    expect(byId.has(wonPlainId)).toBe(false);

    const weekLater = new Date(now.getTime() + 8 * 24 * HOUR);
    const later = (await listDisputesForDesk(runner, weekLater)).map((d) => d.id);
    expect(later).not.toContain(lostId);
  });
});

describe("paid bookings with no time, and disputes", () => {
  it("leave an open or lost dispute to the dispute alert, and mark a won one", async () => {
    const open = await seed({ status: "awaiting_schedule" });
    await addDispute(open.orderId);
    const lost = await seed({ status: "awaiting_schedule" });
    await addDispute(lost.orderId, { status: "lost" });
    const won = await seed({ status: "awaiting_schedule" });
    await addDispute(won.orderId, { status: "won" });
    const clean = await seed({ status: "awaiting_schedule" });

    const listed = await listPaidButUnscheduled(runner);
    const byOrder = new Map(listed.map((p) => [p.orderId, p]));

    expect(byOrder.has(open.orderId)).toBe(false);
    expect(byOrder.has(lost.orderId)).toBe(false);
    expect(byOrder.get(won.orderId)?.disputed).toBe(true);
    expect(byOrder.get(clean.orderId)?.disputed).toBe(false);
  });
});

describe("cancelling a session frees its calendar event too", () => {
  it("hands the booking's event to its hold when the hold lost track of it", async () => {
    const s = await seed();
    await db.query(`update bookings set calendar_event_id = 'evt_kept' where id = $1`, [
      s.bookingId,
    ]);

    await cancelOpenBooking(runner, s.bookingId, NOW);

    const holds = await db.query<{ status: string; calendar_event_id: string | null }>(
      `select status, calendar_event_id from slot_holds where order_id = $1`,
      [s.orderId],
    );
    expect(holds.rows).toEqual([{ status: "released", calendar_event_id: "evt_kept" }]);
  });

  it("writes a released hold for a booking placed by hand, so the sweep deletes its event", async () => {
    const s = await seed();
    await db.query(`delete from slot_holds where order_id = $1`, [s.orderId]);
    await db.query(`update bookings set calendar_event_id = 'evt_by_hand' where id = $1`, [
      s.bookingId,
    ]);

    await cancelOpenBooking(runner, s.bookingId, NOW);

    const holds = await db.query<{ status: string; calendar_event_id: string | null }>(
      `select status, calendar_event_id from slot_holds where order_id = $1`,
      [s.orderId],
    );
    expect(holds.rows).toEqual([{ status: "released", calendar_event_id: "evt_by_hand" }]);
  });
});

describe("retention", () => {
  it("deletes a dispute with its order, so an old unpaid order with one can still be purged", async () => {
    const s = await seed({ paymentStatus: "failed", createdAt: at(-24 * 60) });
    await addDispute(s.orderId, { status: "won" });

    await purgeExpiredPersonalData(runner, NOW);

    const left = await db.query(`select 1 from orders where id = $1`, [s.orderId]);
    expect(left.rows).toEqual([]);
  });
});
