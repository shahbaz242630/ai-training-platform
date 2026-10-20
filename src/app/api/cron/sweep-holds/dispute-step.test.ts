import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderDisputeNeedsResponse } from "@/components/emails/dispute-alert";
import type { PaidButUnscheduled } from "@/data/audit-events";
import type { QueryRunner } from "@/data/db";
import type { DisputeForDesk } from "@/data/disputes";
import { MockEmailProvider } from "@/domain/messaging/mock-provider";
import { resetLogSink, setLogSink } from "@/lib/logger";
import { disputeStep, queueChooseNewTime } from "./dispute-step";

vi.mock("@/config/site", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/site")>()),
  companyName: () => "Example Training",
  supportEmail: () => "desk@example.com",
}));

/**
 * The sweep's part: the choose-a-time email queued once per booking, never
 * after a dispute; the effects of a stolen-card or lost dispute applied again
 * where work remains; and the desk alert per dispute, with its deadline.
 */

let db: PGlite;
let n = 0;
const HOUR = 60 * 60_000;
const NOW = new Date("2027-04-01T09:00:00Z");
const transaction = <T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> =>
  db.transaction((tx) => work(tx as unknown as QueryRunner));

beforeAll(async () => {
  db = await PGlite.create();
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  setLogSink(() => undefined);
  return () => resetLogSink();
});

async function waitingBooking(): Promise<{ orderId: string; bookingId: string }> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`step${n}@example.com`],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_payment_intent_id)
     values ($1, 'single', 'ai-foundations', 129900, 'paid', $2) returning id`,
    [customer.rows[0]!.id, `pi_step_${n}`],
  );
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, customer_timezone)
     values ($1, 'ai-foundations', 1, 'awaiting_schedule', 'Asia/Dubai') returning id`,
    [order.rows[0]!.id],
  );
  return { orderId: order.rows[0]!.id, bookingId: booking.rows[0]!.id };
}

const problem = (
  ids: { orderId: string; bookingId: string },
  over: Partial<PaidButUnscheduled> = {},
): PaidButUnscheduled => ({
  ...ids,
  sessionSlug: "ai-foundations",
  amountFils: 129900,
  paymentIntentId: "pi_x",
  fullyPaid: true,
  disputed: false,
  waitingSince: new Date(NOW.getTime() - HOUR),
  customerEmailedAt: null,
  customerEmailPending: false,
  ...over,
});

async function queued(bookingId: string): Promise<number> {
  const r = await db.query(
    `select 1 from communication_log where booking_id = $1 and template_key = 'choose_new_time'`,
    [bookingId],
  );
  return r.rows.length;
}

describe("queueing the choose-a-time email", () => {
  it("queues it once per booking, however many runs see it", async () => {
    const ids = await waitingBooking();
    const deps = { transaction, clock: () => NOW };

    expect(await queueChooseNewTime([problem(ids)], deps, true)).toEqual({ queued: 1, failed: 0 });
    expect(await queueChooseNewTime([problem(ids)], deps, true)).toEqual({ queued: 0, failed: 0 });
    expect(await queued(ids.bookingId)).toBe(1);
  });

  async function markSent(bookingId: string, at: Date): Promise<void> {
    await db.query(
      `update communication_log set status = 'sent', sent_at = $2
        where booking_id = $1 and template_key = 'choose_new_time'`,
      [bookingId, at],
    );
  }

  async function statusOf(bookingId: string): Promise<string> {
    const r = await db.query<{ status: string }>(
      `select status from communication_log where booking_id = $1 and template_key = 'choose_new_time'`,
      [bookingId],
    );
    return r.rows[0]!.status;
  }

  it("sends it again when the booking lost its time again after the last one went", async () => {
    const ids = await waitingBooking();
    const deps = { transaction, clock: () => NOW };
    await queueChooseNewTime([problem(ids)], deps, true);
    await markSent(ids.bookingId, new Date(NOW.getTime() - 30 * 60_000));

    // Sent in this same wait: not again.
    expect((await queueChooseNewTime([problem(ids)], deps, true)).queued).toBe(0);
    // The customer chose a time and the calendar refused it: waiting again since now.
    const again = problem(ids, { waitingSince: NOW });
    expect((await queueChooseNewTime([again], deps, true)).queued).toBe(1);
    expect(await statusOf(ids.bookingId)).toBe("queued");
  });

  it("sends a fresh link once the last one has run out", async () => {
    const ids = await waitingBooking();
    const deps = { transaction, clock: () => NOW };
    const longAgo = new Date(NOW.getTime() - 8 * 24 * HOUR);
    await queueChooseNewTime([problem(ids, { waitingSince: longAgo })], deps, true);
    await markSent(ids.bookingId, new Date(longAgo.getTime() + HOUR));

    const result = await queueChooseNewTime([problem(ids, { waitingSince: longAgo })], deps, true);

    expect(result.queued).toBe(1);
  });

  it("never for a disputed order, a part-refunded one, or when no link can be made", async () => {
    const deps = { transaction, clock: () => NOW };
    const disputed = await waitingBooking();
    const partRefunded = await waitingBooking();
    const noSecret = await waitingBooking();

    await queueChooseNewTime([problem(disputed, { disputed: true })], deps, true);
    await queueChooseNewTime([problem(partRefunded, { fullyPaid: false })], deps, true);
    await queueChooseNewTime([problem(noSecret)], deps, false);

    expect(await queued(disputed.bookingId)).toBe(0);
    expect(await queued(partRefunded.bookingId)).toBe(0);
    expect(await queued(noSecret.bookingId)).toBe(0);
  });
});

describe("the dispute step", () => {
  it("cancels the session of a stolen-card dispute linked late, and tells the desk once", async () => {
    const ids = await waitingBooking();
    await db.query(
      `insert into payment_disputes (provider_dispute_id, payment_intent_id, amount_minor, currency,
                                     reason, status, evidence_due_by)
       select 'dp_late', stripe_payment_intent_id, 129900, 'AED', 'fraudulent', 'needs_response', $2
         from orders where id = $1`,
      [ids.orderId, new Date(NOW.getTime() + 5 * 24 * HOUR)],
    );
    const email = new MockEmailProvider();
    const deps = {
      transaction,
      email: () => email,
      clock: () => NOW,
      desk: () => "desk@example.com",
    };

    const report = await disputeStep(deps);

    expect(report).toMatchObject({ linked: 1, cancelledBookings: 1, failed: 0 });
    const booking = await db.query<{ status: string }>(
      `select status from bookings where id = $1`,
      [ids.bookingId],
    );
    expect(booking.rows[0]!.status).toBe("cancelled");
    expect(email.sent.filter((m) => m.subject.includes("Payment disputed"))).toHaveLength(1);

    // The next run finds nothing more to do and does not email again the same day.
    const again = await disputeStep(deps);
    expect(again).toMatchObject({ linked: 0, cancelledBookings: 0 });
    expect(email.sent.filter((m) => m.subject.includes("Payment disputed"))).toHaveLength(1);
  });
});

function forDesk(over: Partial<DisputeForDesk> = {}): DisputeForDesk {
  return {
    id: "00000000-0000-4000-8000-0000000000d1",
    providerDisputeId: "dp_desk",
    orderId: "00000000-0000-4000-8000-0000000000aa",
    paymentIntentId: "pi_desk",
    amountMinor: 129900,
    currency: "AED",
    reason: "product_not_received",
    status: "needs_response",
    evidenceDueBy: new Date(NOW.getTime() + 6 * 24 * HOUR),
    bookingId: "3f9a1c2b-0000-4000-8000-000000000001",
    bookingStatus: "confirmed",
    sessionSlug: "ai-foundations",
    sessionStart: new Date(NOW.getTime() + 3 * 24 * HOUR),
    kind: "respond",
    sessionCancelledByDispute: false,
    refunds: [],
    termsVersion: "2026-10-15",
    termsAcceptedAt: new Date(NOW.getTime() - 24 * HOUR),
    expressRequest: false,
    emailsSent: [{ templateKey: "booking_confirmation", sentAt: new Date(NOW.getTime() - HOUR) }],
    ...over,
  };
}

describe("the dispute desk alert", () => {
  it("leads with the deadline and lists the evidence on record", async () => {
    const email = await renderDisputeNeedsResponse(forDesk(), false, NOW);
    expect(email.subject).toBe("Payment disputed: booking 3F9A1C2B, AED 1299.00");
    expect(email.text).toContain("Deadline:");
    expect(email.text).toContain("Dubai time");
    expect(email.text).toContain("Coaching Terms version 2026-10-15");
    expect(email.text).toContain("booking_confirmation");
    expect(email.text).toContain("left as booked, on purpose");
    expect(email.text).toContain("has not been told anything by the app");
  });

  it("is marked urgent in the last two days", async () => {
    const soon = forDesk({ evidenceDueBy: new Date(NOW.getTime() + 20 * HOUR) });
    const email = await renderDisputeNeedsResponse(soon, true, NOW);
    expect(email.subject).toMatch(/^URGENT, deadline in under 48 hours\./);
  });

  it("says an inquiry can be settled by a refund with no fee", async () => {
    const email = await renderDisputeNeedsResponse(
      forDesk({ status: "warning_needs_response" }),
      false,
      NOW,
    );
    expect(email.subject).toContain("Payment inquiry");
    expect(email.text).toContain("no dispute fee");
  });

  it("lists a refund already made, so the desk never pays twice", async () => {
    const email = await renderDisputeNeedsResponse(
      forDesk({ refunds: [{ amountFils: 129900, status: "succeeded", createdAt: NOW }] }),
      false,
      NOW,
    );
    expect(email.text).toContain("REFUND on record: AED 1,299");
    expect(email.text).toContain("never refund again on top of a dispute");
  });

  it("tells the desk when a dispute was won after it cancelled a session", async () => {
    const email = await renderDisputeNeedsResponse(
      forDesk({
        kind: "outcome",
        status: "won",
        reason: "fraudulent",
        sessionCancelledByDispute: true,
      }),
      false,
      NOW,
    );
    expect(email.subject).toBe("Dispute won, session was cancelled: booking 3F9A1C2B, AED 1299.00");
    expect(email.text).toContain("has paid and has no session");
    expect(email.text).toContain("book a new time for them by hand");
    expect(email.text).not.toContain("Deadline:");
  });

  it("tells the desk when a dispute is lost, and not to refund as well", async () => {
    const email = await renderDisputeNeedsResponse(
      forDesk({ kind: "outcome", status: "lost" }),
      false,
      NOW,
    );
    expect(email.subject).toContain("Dispute lost");
    expect(email.text).toContain("Do not refund as well");
  });

  it("says an inquiry left alone can become a chargeback, not that it is lost by itself", async () => {
    const email = await renderDisputeNeedsResponse(
      forDesk({ status: "warning_needs_response" }),
      false,
      NOW,
    );
    expect(email.text).toContain("it can turn into a chargeback");
    expect(email.text).not.toContain("lost by itself");
  });

  it("carries no customer email address or name", async () => {
    const email = await renderDisputeNeedsResponse(forDesk(), false, NOW);
    const all = `${email.subject}${email.text}${email.html}`.replaceAll("desk@example.com", "");
    expect(all).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
    expect(all).not.toContain("Amina");
  });
});
