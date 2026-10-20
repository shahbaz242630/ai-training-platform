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
import { DisputeReadError, type DisputeSnapshot } from "@/domain/payments/provider";
import { resetAuditSink, setAuditSink } from "@/lib/audit";
import { resetLogSink, setLogSink } from "@/lib/logger";
import type { QueryRunner } from "@/data/db";

/**
 * Dispute events through the real webhook route: a signed delivery in, the
 * dispute stored as the processor has it now, and what it does to the session
 * (founder rules, October 2026): a stolen-card chargeback cancels a session
 * still more than two hours away; any other dispute leaves it as booked; a
 * lost one cancels a session still to come. The customer is never emailed by
 * the app about a dispute.
 */

const provider = new MockPaymentProvider();
let db: PGlite;

vi.mock("@/domain/payments/factory", () => ({
  getPaymentProvider: () => provider,
  paymentsAreConfigured: () => true,
}));

vi.mock("@/data/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/db")>()),
  withTransaction: async <T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> =>
    db.transaction((tx) => work(tx as unknown as QueryRunner)),
}));

import { POST } from "./route";

const HOUR = 60 * 60_000;
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
  setAuditSink(() => undefined);
  setLogSink(() => undefined);
});

afterEach(() => {
  resetAuditSink();
  resetLogSink();
});

interface Seeded {
  readonly orderId: string;
  readonly bookingId: string;
  readonly intent: string;
  readonly holdId: string;
}

/**
 * A paid, confirmed booking with its converted hold, as confirmation leaves
 * it. Each one at its own time, a day apart, so no two overlap.
 */
async function confirmedBooking(startsInHours: number): Promise<Seeded> {
  n += 1;
  const start = new Date(Date.now() + startsInHours * HOUR + n * 24 * HOUR);
  const end = new Date(start.getTime() + HOUR);
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`dispute${n}@example.com`],
  );
  const intent = `pi_dispute_${n}`;
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_payment_intent_id)
     values ($1, 'single', 'ai-foundations', 129900, 'paid', $2) returning id`,
    [customer.rows[0]!.id, intent],
  );
  const orderId = order.rows[0]!.id;
  const event = `evt_cal_${n}`;
  const hold = await db.query<{ id: string }>(
    `insert into slot_holds (slot_start, slot_end, order_id, calendar_event_id, expires_at, status)
     values ($1, $2, $3, $4, $1, 'converted') returning id`,
    [start, end, orderId, event],
  );
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, customer_timezone,
                           scheduled_start, scheduled_end, calendar_event_id, meeting_url)
     values ($1, 'ai-foundations', 1, 'confirmed', 'Asia/Dubai', $2, $3, $4,
             'https://teams.example/join') returning id`,
    [orderId, start, end, event],
  );
  return { orderId, bookingId: booking.rows[0]!.id, intent, holdId: hold.rows[0]!.id };
}

/** Move a booking's session to a given number of hours from now (for the "too close" and "past" cases). */
async function startAt(seeded: Seeded, hoursFromNow: number): Promise<void> {
  const start = new Date(Date.now() + hoursFromNow * HOUR);
  const end = new Date(start.getTime() + HOUR);
  await db.query(`update bookings set scheduled_start = $2, scheduled_end = $3 where id = $1`, [
    seeded.bookingId,
    start,
    end,
  ]);
  await db.query(`update slot_holds set slot_start = $2, slot_end = $3 where id = $1`, [
    seeded.holdId,
    start,
    end,
  ]);
}

function dispute(intent: string | null, over: Partial<DisputeSnapshot> = {}): DisputeSnapshot {
  const snapshot: DisputeSnapshot = {
    providerDisputeId: `dp_${randomUUID()}`,
    paymentIntentId: intent,
    amountMinor: 129900,
    currency: "AED",
    reason: "fraudulent",
    status: "needs_response",
    evidenceDueBy: new Date(Date.now() + 7 * 24 * HOUR),
    ...over,
  };
  provider.disputes.set(snapshot.providerDisputeId, snapshot);
  return snapshot;
}

async function deliver(providerDisputeId: string, type = "charge.dispute.created", id?: string) {
  const body: MockEventBody = { id: id ?? `evt_${randomUUID()}`, type, providerDisputeId };
  const raw = mockEventBody(body);
  const headers = new Headers({ "stripe-signature": provider.sign(raw) });
  const response = await POST(
    new Request("https://example.test/api/webhooks/stripe", { method: "POST", headers, body: raw }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function bookingStatus(bookingId: string): Promise<string> {
  const r = await db.query<{ status: string }>(`select status from bookings where id = $1`, [
    bookingId,
  ]);
  return r.rows[0]!.status;
}

async function stored(providerDisputeId: string) {
  const r = await db.query<{ order_id: string | null; status: string; reason: string }>(
    `select order_id, status, reason from payment_disputes where provider_dispute_id = $1`,
    [providerDisputeId],
  );
  return r.rows[0];
}

async function queuedTemplates(bookingId: string): Promise<string[]> {
  const r = await db.query<{ template_key: string }>(
    `select template_key from communication_log where booking_id = $1 and status = 'queued'`,
    [bookingId],
  );
  return r.rows.map((row) => row.template_key);
}

describe("a stolen-card chargeback", () => {
  it("cancels a session still to come, frees its time, and emails nobody", async () => {
    const seeded = await confirmedBooking(72);
    await db.query(
      `insert into communication_log (booking_id, channel, template_key, status, scheduled_for)
       values ($1, 'email', 'reminder_24h', 'queued', now() + interval '2 days')`,
      [seeded.bookingId],
    );
    const d = dispute(seeded.intent);

    const result = await deliver(d.providerDisputeId);

    expect(result.status).toBe(200);
    expect(await bookingStatus(seeded.bookingId)).toBe("cancelled");
    expect((await stored(d.providerDisputeId))?.order_id).toBe(seeded.orderId);
    // The hold is released with its event, so the sweep deletes the calendar event.
    const hold = await db.query<{ status: string; calendar_event_id: string | null }>(
      `select status, calendar_event_id from slot_holds where id = $1`,
      [seeded.holdId],
    );
    expect(hold.rows[0]).toEqual({ status: "released", calendar_event_id: expect.any(String) });
    // The reminder is withdrawn, and no "cancelled and refunded" email is queued.
    expect(await queuedTemplates(seeded.bookingId)).toEqual([]);
  });

  it("leaves a session less than two hours away for the desk", async () => {
    const seeded = await confirmedBooking(72);
    await startAt(seeded, 1);
    const d = dispute(seeded.intent);

    await deliver(d.providerDisputeId);

    expect(await bookingStatus(seeded.bookingId)).toBe("confirmed");
  });

  it("never touches a session that has already taken place: it is the evidence", async () => {
    const seeded = await confirmedBooking(72);
    await startAt(seeded, -30);
    const d = dispute(seeded.intent);

    await deliver(d.providerDisputeId);

    expect(await bookingStatus(seeded.bookingId)).toBe("confirmed");
  });
});

describe("any other dispute", () => {
  it("leaves the session as booked: a session that was there is the evidence", async () => {
    const seeded = await confirmedBooking(72);
    const d = dispute(seeded.intent, { reason: "product_not_received" });

    await deliver(d.providerDisputeId);

    expect(await bookingStatus(seeded.bookingId)).toBe("confirmed");
    expect((await stored(d.providerDisputeId))?.status).toBe("needs_response");
  });

  it("an inquiry about a stolen card leaves the session too: no money has moved", async () => {
    const seeded = await confirmedBooking(72);
    const d = dispute(seeded.intent, { status: "warning_needs_response" });

    await deliver(d.providerDisputeId);

    expect(await bookingStatus(seeded.bookingId)).toBe("confirmed");
  });

  it("once lost, cancels the session still to come", async () => {
    const seeded = await confirmedBooking(72);
    const d = dispute(seeded.intent, { reason: "product_not_received" });
    await deliver(d.providerDisputeId);
    provider.disputes.set(d.providerDisputeId, { ...d, status: "lost" });

    await deliver(d.providerDisputeId, "charge.dispute.closed");

    expect(await bookingStatus(seeded.bookingId)).toBe("cancelled");
    expect((await stored(d.providerDisputeId))?.status).toBe("lost");
  });

  it("once won, changes nothing by itself", async () => {
    const seeded = await confirmedBooking(72);
    const d = dispute(seeded.intent, { reason: "product_not_received", status: "won" });

    await deliver(d.providerDisputeId, "charge.dispute.closed");

    expect(await bookingStatus(seeded.bookingId)).toBe("confirmed");
  });
});

describe("the dispute as stored", () => {
  /*
    Events are not delivered in order. The handler reads the dispute again,
    and a status only moves forward, so an answer read a moment earlier but
    stored later cannot take the dispute backwards.
  */
  it("never moves backwards when an older answer is stored after a newer one", async () => {
    const seeded = await confirmedBooking(72);
    const d = dispute(seeded.intent, { reason: "product_not_received", status: "under_review" });
    await deliver(d.providerDisputeId, "charge.dispute.updated");
    provider.disputes.set(d.providerDisputeId, { ...d, status: "needs_response" });

    const late = await deliver(d.providerDisputeId, "charge.dispute.created");

    expect(late.body.outcome).toBe("stale");
    expect((await stored(d.providerDisputeId))?.status).toBe("under_review");
  });

  it("does nothing on a repeated delivery of the same event", async () => {
    const seeded = await confirmedBooking(72);
    const d = dispute(seeded.intent, { reason: "product_not_received" });
    const eventId = `evt_${randomUUID()}`;
    await deliver(d.providerDisputeId, "charge.dispute.created", eventId);

    const again = await deliver(d.providerDisputeId, "charge.dispute.created", eventId);

    expect(again.body.outcome).toBe("duplicate");
  });

  it("keeps a dispute on a payment we cannot find, for the desk", async () => {
    const d = dispute("pi_nobody_knows");

    const result = await deliver(d.providerDisputeId);

    expect(result.status).toBe(200);
    expect((await stored(d.providerDisputeId))?.order_id).toBeNull();
  });

  /*
    A clear refusal (a key without the right, say) will not change on a retry:
    failing the delivery for three days would store nothing and tell nobody.
    The event's own copy is stored instead.
  */
  it("stores the event's own copy when the processor clearly refuses to be asked", async () => {
    const seeded = await confirmedBooking(72);
    provider.disputeReadFailure = new DisputeReadError("permission_denied", false);
    const body: MockEventBody = {
      id: `evt_${randomUUID()}`,
      type: "charge.dispute.created",
      providerDisputeId: "dp_refused_read",
      paymentIntentId: seeded.intent,
      disputeStatus: "needs_response",
      disputeReason: "product_not_received",
    };
    const raw = mockEventBody(body);
    const response = await POST(
      new Request("https://example.test/api/webhooks/stripe", {
        method: "POST",
        headers: new Headers({ "stripe-signature": provider.sign(raw) }),
        body: raw,
      }),
    );

    expect(response.status).toBe(200);
    expect(await stored("dp_refused_read")).toMatchObject({
      order_id: seeded.orderId,
      status: "needs_response",
    });
  });

  it("fails the delivery when the dispute cannot be read, so the processor sends it again", async () => {
    const eventId = `evt_${randomUUID()}`;

    const first = await deliver("dp_not_there_yet", "charge.dispute.created", eventId);
    expect(first.status).toBe(500);

    // Nothing was claimed, so the redelivery is acted on.
    const seeded = await confirmedBooking(72);
    provider.disputes.set("dp_not_there_yet", {
      ...dispute(seeded.intent, { reason: "product_not_received" }),
      providerDisputeId: "dp_not_there_yet",
    });
    const retry = await deliver("dp_not_there_yet", "charge.dispute.created", eventId);
    expect(retry.status).toBe(200);
    expect(retry.body.outcome).toBe("recorded");
  });
});
