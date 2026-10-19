import type { QueryRunner } from "./db";
import { insertAuditEvent } from "./audit-events";
import { orderHasDispute } from "./disputes";
import { scheduleBooking, type Booking, type BookingStatus } from "@/domain/booking/booking";
import type { PaymentStatus } from "@/domain/booking/order";

/**
 * A new time for a paid booking that lost its own (KC B8).
 *
 * The held time was cancelled or deleted in Outlook before the booking was
 * confirmed, or the payment landed after the hold expired. The customer has
 * paid and has no session. The policy promises them a full refund or a new
 * time; this is the new time, chosen by the customer from a link the desk
 * sends them.
 *
 * It is not a move. Losing the time was our doing, and moves we make never
 * count against the customer: `reschedule_count` is untouched, so their one
 * free move is still there afterwards.
 *
 * The booking ends `scheduled`, exactly where settlement leaves a booking
 * whose hold converted, and the confirmation step does the rest the way it
 * does for every booking: the calendar event, the meeting link, the
 * confirmation email and the reminders. If the calendar is down, the sweep
 * confirms it later. The double-booking guarantees are the same database
 * constraints a checkout goes through: the time is claimed as a converted
 * hold and the booking's own times must not overlap another session. Either
 * refusal throws and the caller's transaction rolls back.
 *
 * Call inside a transaction. The row lock makes two submissions from the same
 * link queue behind each other, and the second then finds the booking already
 * scheduled.
 */

export type ChooseTimeOutcome =
  | { readonly kind: "scheduled"; readonly start: Date; readonly end: Date }
  | {
      readonly kind: "refused";
      readonly reason: "not_waiting" | "not_paid" | "not_found" | "disputed";
    };

export interface ChooseTimeInput {
  readonly bookingId: string;
  readonly newSlot: { readonly start: Date; readonly end: Date };
  readonly now: Date;
}

export async function scheduleWaitingBooking(
  runner: QueryRunner,
  input: ChooseTimeInput,
): Promise<ChooseTimeOutcome> {
  // The order first, then the booking: the order every other money path locks in.
  await runner.query(
    `select o.id from orders o join bookings b on b.order_id = o.id
      where b.id = $1
      for update of o`,
    [input.bookingId],
  );
  const found = await runner.query<{
    id: string;
    order_id: string;
    session_slug: string;
    sequence: number;
    status: BookingStatus;
    customer_timezone: string;
    scheduler_external_id: string | null;
    calendar_event_id: string | null;
    meeting_url: string | null;
    created_at: Date;
    updated_at: Date;
    payment_status: PaymentStatus;
    customer_id: string;
  }>(
    `select b.id, b.order_id, b.session_slug, b.sequence, b.status, b.customer_timezone,
            b.scheduler_external_id, b.calendar_event_id, b.meeting_url, b.created_at,
            b.updated_at, o.payment_status, o.customer_id
       from bookings b
       join orders o on o.id = b.order_id
      where b.id = $1
      for update of b`,
    [input.bookingId],
  );
  const row = found.rows[0];
  if (!row) return { kind: "refused", reason: "not_found" };
  if (row.status !== "awaiting_schedule") return { kind: "refused", reason: "not_waiting" };
  // Exactly paid: only a paid order confirms. A part-refunded one is the desk's to settle.
  if (row.payment_status !== "paid") return { kind: "refused", reason: "not_paid" };
  // While the bank is disputing the payment, no time is given: a person decides.
  if (await orderHasDispute(runner, row.order_id)) return { kind: "refused", reason: "disputed" };

  const { start, end } = input.newSlot;
  const booking: Booking = {
    id: row.id,
    orderId: row.order_id,
    sessionSlug: row.session_slug,
    sequence: row.sequence,
    status: row.status,
    scheduledStart: null,
    scheduledEnd: null,
    customerTimezone: row.customer_timezone,
    schedulerExternalId: row.scheduler_external_id,
    calendarEventId: row.calendar_event_id,
    meetingUrl: row.meeting_url,
    meetingProvider: "microsoft_teams",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  // No event yet: the confirmation step blocks the calendar for the new time.
  const scheduled = scheduleBooking(booking, { start, end, calendarEventId: null }, input.now);

  // The new time, claimed under the same constraint every checkout goes through.
  await runner.query(
    `insert into slot_holds (slot_start, slot_end, order_id, calendar_event_id, expires_at, status)
     values ($1, $2, $3, null, $4, 'converted')`,
    [start, end, row.order_id, input.now],
  );

  await runner.query(
    `update bookings
        set status = $2, scheduled_start = $3, scheduled_end = $4, calendar_event_id = null,
            updated_at = $5
      where id = $1 and status = 'awaiting_schedule'`,
    [row.id, scheduled.entity.status, start, end, input.now],
  );

  await insertAuditEvent(runner, {
    action: "booking.time_chosen_after_loss",
    actor: { kind: "customer", customerId: row.customer_id },
    subject: `booking:${row.id}`,
    metadata: { orderId: row.order_id, to: start.toISOString() },
    occurredAt: input.now.toISOString(),
  });

  return { kind: "scheduled", start, end };
}
