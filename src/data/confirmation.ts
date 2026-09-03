import type { QueryRunner } from "./db";
import { queueForBooking } from "./communications";
import { getSessionBySlug } from "@/config/sessions";
import {
  confirmBooking,
  releaseBookingSlot,
  type Booking,
  type BookingStatus,
} from "@/domain/booking/booking";
import type { PaymentStatus } from "@/domain/booking/order";
import { messagesOnConfirmation } from "@/domain/messaging/schedule";
import {
  SchedulingError,
  SlotUnavailableError,
  type SchedulingProvider,
} from "@/domain/scheduling/provider";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * From "paid and scheduled" to "confirmed, on the calendar, with a link".
 *
 * Settlement stops at `scheduled` on purpose: it runs inside the webhook's
 * transaction and must not wait on a calendar. This is the step after it,
 * and it is the only place a booking becomes `confirmed`. It is attempted
 * straight after settlement and again by the sweep until it succeeds, so
 * every step here is safe to repeat:
 *
 *   - confirming an event the calendar has already confirmed is a no-op;
 *   - the booking update is guarded on `status = 'scheduled'`, so two
 *     confirmers cannot both queue the emails;
 *   - the queue itself is unique per template per booking.
 *
 * The one failure that is not retried is the calendar refusing the time -
 * the event was cancelled or the slot lost. The order stays paid, the
 * booking goes back to waiting, and the standing paid-but-unscheduled alarm
 * brings a person to it. Nobody is charged again.
 */

export type ConfirmationOutcome =
  /** Event confirmed, link recorded, booking confirmed, messages queued. */
  | "confirmed"
  /** Already done, by an earlier attempt. Nothing changed. */
  | "already_confirmed"
  /** No such booking, or it is not in the state this step starts from. */
  | "not_scheduled"
  /** The order is not paid. Should be unreachable; refused rather than assumed. */
  | "order_not_paid"
  /** The calendar no longer has the time. Booking returned to waiting; a person is needed. */
  | "slot_lost";

export interface BookingForConfirmation {
  readonly id: string;
  readonly orderId: string;
  readonly sessionSlug: string;
  readonly sequence: number;
  readonly status: BookingStatus;
  readonly scheduledStart: Date | null;
  readonly scheduledEnd: Date | null;
  readonly customerTimezone: string;
  readonly schedulerExternalId: string | null;
  readonly calendarEventId: string | null;
  readonly meetingUrl: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly orderPaymentStatus: PaymentStatus;
  readonly customerFirstName: string;
  readonly customerLastName: string;
  readonly customerEmail: string;
}

export async function loadBookingForConfirmation(
  runner: QueryRunner,
  bookingId: string,
): Promise<BookingForConfirmation | null> {
  const result = await runner.query<{
    id: string;
    order_id: string;
    session_slug: string;
    sequence: number;
    status: BookingStatus;
    scheduled_start: Date | null;
    scheduled_end: Date | null;
    customer_timezone: string;
    scheduler_external_id: string | null;
    calendar_event_id: string | null;
    meeting_url: string | null;
    created_at: Date;
    updated_at: Date;
    payment_status: PaymentStatus;
    first_name: string;
    last_name: string;
    email: string;
  }>(
    `select b.id, b.order_id, b.session_slug, b.sequence, b.status, b.scheduled_start,
            b.scheduled_end, b.customer_timezone, b.scheduler_external_id, b.calendar_event_id,
            b.meeting_url, b.created_at, b.updated_at,
            o.payment_status, c.first_name, c.last_name, c.email
       from bookings b
       join orders o on o.id = b.order_id
       join customers c on c.id = o.customer_id
      where b.id = $1`,
    [bookingId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    orderId: row.order_id,
    sessionSlug: row.session_slug,
    sequence: row.sequence,
    status: row.status,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    customerTimezone: row.customer_timezone,
    schedulerExternalId: row.scheduler_external_id,
    calendarEventId: row.calendar_event_id,
    meetingUrl: row.meeting_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    orderPaymentStatus: row.payment_status,
    customerFirstName: row.first_name,
    customerLastName: row.last_name,
    customerEmail: row.email,
  };
}

/** Every booking on an order, in sequence. */
export async function bookingIdsForOrder(runner: QueryRunner, orderId: string): Promise<string[]> {
  const result = await runner.query<{ id: string }>(
    `select id from bookings where order_id = $1 order by sequence`,
    [orderId],
  );
  return result.rows.map((row) => row.id);
}

/**
 * Bookings that are paid for and scheduled but not yet on the calendar - the
 * ones an earlier attempt did not finish. Oldest first, bounded.
 */
export async function listBookingsAwaitingConfirmation(
  runner: QueryRunner,
  limit: number,
): Promise<string[]> {
  const result = await runner.query<{ id: string }>(
    `select b.id
       from bookings b
       join orders o on o.id = b.order_id
      where b.status = 'scheduled' and o.payment_status = 'paid'
      order by b.updated_at
      limit $1`,
    [limit],
  );
  return result.rows.map((row) => row.id);
}

export type TransactionRunner = <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;

export interface ConfirmOnCalendarInput {
  readonly bookingId: string;
  readonly provider: SchedulingProvider;
  readonly now: Date;
  readonly transaction: TransactionRunner;
}

export async function confirmBookingOnCalendar(
  input: ConfirmOnCalendarInput,
): Promise<ConfirmationOutcome> {
  const { bookingId, provider, now, transaction } = input;

  const booking = await transaction((runner) => loadBookingForConfirmation(runner, bookingId));
  if (booking === null) return "not_scheduled";
  if (booking.status === "confirmed") return "already_confirmed";
  if (booking.status !== "scheduled" || !booking.scheduledStart || !booking.scheduledEnd) {
    return "not_scheduled";
  }
  if (booking.orderPaymentStatus !== "paid") return "order_not_paid";

  const slot = { start: booking.scheduledStart, end: booking.scheduledEnd };
  const session = getSessionBySlug(booking.sessionSlug);
  const subject = session ? session.title : "Private session";
  const attendee = {
    attendeeName: `${booking.customerFirstName} ${booking.customerLastName}`.trim(),
    attendeeEmail: booking.customerEmail,
  };

  let event;
  try {
    let eventId = booking.calendarEventId;
    if (eventId === null) {
      /*
        Nothing was blocked at checkout - the calendar was unreachable then.
        Block it now, then confirm. The booking id is the idempotency key, so
        a repeat of this path cannot leave two events behind.
      */
      const held = await provider.holdSlot({
        slot,
        subject,
        ...attendee,
        holdReference: `booking:${booking.id}`,
      });
      eventId = held.externalId;
    }
    event = await provider.confirmSlot(eventId, attendee);
  } catch (error) {
    if (error instanceof SlotUnavailableError) {
      await returnToWaiting(transaction, booking, now);
      return "slot_lost";
    }
    throw error;
  }

  if (event.meetingUrl === null) {
    // The provider contract says a confirmed event carries its link. Refused
    // here too, because a confirmation email with nowhere to click is the one
    // thing this step must never produce.
    throw new SchedulingError(`Event ${event.externalId} was confirmed without a meeting link`);
  }
  const meetingUrl = event.meetingUrl;

  const changed = await transaction(async (runner) => {
    const domain = confirmBooking(
      toBooking(booking),
      { orderPaymentStatus: "paid", meetingUrl, calendarEventId: event.externalId },
      now,
    );
    if (!domain.changed) return false;

    const updated = await runner.query<{ id: string }>(
      `update bookings
          set status = 'confirmed', meeting_url = $2, calendar_event_id = $3,
              scheduler_external_id = $3, updated_at = $4
        where id = $1 and status = 'scheduled'
        returning id`,
      [booking.id, meetingUrl, event.externalId, now],
    );
    // Lost a race with another confirmer, which has already queued the messages.
    if (updated.rows.length === 0) return false;

    await queueForBooking(
      runner,
      booking.id,
      messagesOnConfirmation({ scheduledStart: slot.start, scheduledEnd: slot.end, now }),
    );
    return true;
  });

  if (!changed) return "already_confirmed";

  await recordAudit({
    action: "booking.confirmed",
    actor: { kind: "system", process: "calendar-confirmation" },
    subject: `booking:${booking.id}`,
    metadata: { orderId: booking.orderId, calendarEventId: event.externalId },
  });
  logger.info("booking confirmed on the calendar", {
    bookingId: booking.id,
    calendarEventId: event.externalId,
  });
  return "confirmed";
}

/**
 * The calendar refused the time. The order stays paid; the booking goes back
 * to waiting with its times cleared, so nothing downstream can read a slot
 * the calendar no longer holds. The standing alarm picks it up from here.
 */
async function returnToWaiting(
  transaction: TransactionRunner,
  booking: BookingForConfirmation,
  now: Date,
): Promise<void> {
  await transaction(async (runner) => {
    const domain = releaseBookingSlot(toBooking(booking), now);
    if (!domain.changed) return;
    await runner.query(
      `update bookings
          set status = 'awaiting_schedule', scheduled_start = null, scheduled_end = null,
              calendar_event_id = null, updated_at = $2
        where id = $1 and status = 'scheduled'`,
      [booking.id, now],
    );
  });
  logger.error(
    "PAID BUT THE CALENDAR NO LONGER HAS THE SLOT - booking returned to waiting, needs rescheduling by hand, do not charge again",
    { bookingId: booking.id, orderId: booking.orderId },
  );
}

function toBooking(row: BookingForConfirmation): Booking {
  return {
    id: row.id,
    orderId: row.orderId,
    sessionSlug: row.sessionSlug,
    sequence: row.sequence,
    status: row.status,
    scheduledStart: row.scheduledStart,
    scheduledEnd: row.scheduledEnd,
    customerTimezone: row.customerTimezone,
    schedulerExternalId: row.schedulerExternalId,
    calendarEventId: row.calendarEventId,
    meetingUrl: row.meetingUrl,
    meetingProvider: "microsoft_teams",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
