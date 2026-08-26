import type { PaymentStatus } from "./order";
import { assertTransition, type TransitionResult, type TransitionTable } from "./transitions";

/**
 * A Booking is ONE SCHEDULED SESSION OCCURRENCE. It owns scheduling state and
 * owns nothing else - payment state lives on the Order and is never copied here.
 *
 * An Order has one or more Bookings: one for a single session, two for a
 * pathway, at two different times.
 */

export type BookingStatus =
  "awaiting_schedule" | "scheduled" | "confirmed" | "completed" | "cancelled" | "no_show";

export interface Booking {
  readonly id: string;
  readonly orderId: string;
  readonly sessionSlug: string;
  /** 1 or 2 within its order. The two sessions of a pathway are ordered. */
  readonly sequence: number;
  readonly status: BookingStatus;
  /** UTC, both. Null until a slot is chosen. Rendering converts; storage never does. */
  readonly scheduledStart: Date | null;
  readonly scheduledEnd: Date | null;
  /** IANA zone, e.g. "Asia/Dubai". Kept so a confirmation renders in the customer own zone. */
  readonly customerTimezone: string;
  readonly schedulerExternalId: string | null;
  readonly calendarEventId: string | null;
  readonly meetingUrl: string | null;
  readonly meetingProvider: "microsoft_teams";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Permitted scheduling moves.
 *
 * The move back from `scheduled` to `awaiting_schedule` is the recovery path,
 * and it is the whole reason this table has a way back. If payment succeeds
 * but the calendar slot turns out to be gone, the order stays paid and the
 * booking returns here to be rescheduled by hand. That state is recoverable
 * and alerted - never a silent failure, and never a second charge.
 */
const BOOKING_TRANSITIONS: TransitionTable<BookingStatus> = {
  awaiting_schedule: ["scheduled", "cancelled"],
  scheduled: ["confirmed", "awaiting_schedule", "cancelled"],
  confirmed: ["completed", "no_show", "cancelled"],
  completed: [],
  cancelled: [],
  no_show: [],
};

export class BookingShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingShapeError";
  }
}

/**
 * Refusing to confirm a booking whose order is not paid.
 *
 * This is the most expensive mistake this codebase could make, so it is a
 * distinct error type rather than a generic one - it should not be possible to
 * swallow by accident while handling something else.
 */
export class UnpaidConfirmationError extends Error {
  constructor(bookingId: string, paymentStatus: PaymentStatus) {
    super(
      `Booking "${bookingId}" cannot be confirmed while its order is "${paymentStatus}" - ` +
        "only a verified payment confirms a booking",
    );
    this.name = "UnpaidConfirmationError";
  }
}

export interface CreateBookingInput {
  readonly id: string;
  readonly orderId: string;
  readonly sessionSlug: string;
  readonly sequence: number;
  readonly customerTimezone: string;
  readonly now: Date;
}

/**
 * The only way to make a Booking. It starts `awaiting_schedule` with no times:
 * a booking cannot be born already scheduled, because a slot is something the
 * customer chooses and the calendar has to accept.
 */
export function createBooking(input: CreateBookingInput): Booking {
  if (input.sequence !== 1 && input.sequence !== 2) {
    throw new BookingShapeError("sequence must be 1 or 2 - v1 sells single sessions and pairs");
  }
  if (input.customerTimezone.trim() === "") {
    throw new BookingShapeError("customerTimezone is required so times can be rendered correctly");
  }

  return {
    id: input.id,
    orderId: input.orderId,
    sessionSlug: input.sessionSlug,
    sequence: input.sequence,
    status: "awaiting_schedule",
    scheduledStart: null,
    scheduledEnd: null,
    customerTimezone: input.customerTimezone,
    schedulerExternalId: null,
    calendarEventId: null,
    meetingUrl: null,
    meetingProvider: "microsoft_teams",
    createdAt: input.now,
    updatedAt: input.now,
  };
}

export interface ScheduleBookingInput {
  /** UTC, and start must precede end. */
  readonly start: Date;
  readonly end: Date;
  readonly schedulerExternalId?: string | null;
  readonly calendarEventId?: string | null;
}

/** Attach a chosen slot. The times arrive together with the status, never after it. */
export function scheduleBooking(
  booking: Booking,
  slot: ScheduleBookingInput,
  now: Date,
): TransitionResult<Booking> {
  if (slot.start.getTime() >= slot.end.getTime()) {
    throw new BookingShapeError("A slot must start before it ends");
  }
  assertTransition("Booking", BOOKING_TRANSITIONS, booking.status, "scheduled");

  return {
    entity: {
      ...booking,
      status: "scheduled",
      scheduledStart: slot.start,
      scheduledEnd: slot.end,
      schedulerExternalId: slot.schedulerExternalId ?? booking.schedulerExternalId,
      calendarEventId: slot.calendarEventId ?? booking.calendarEventId,
      updatedAt: now,
    },
    changed: true,
  };
}

export interface ConfirmBookingInput {
  /** Read from the Order. Passed in rather than looked up so the caller cannot omit it. */
  readonly orderPaymentStatus: PaymentStatus;
  readonly meetingUrl?: string;
  readonly calendarEventId?: string;
}

/**
 * Confirm a booking. Only a verified payment reaches this, and only for a
 * booking that already holds a slot.
 *
 * `orderPaymentStatus` is a required argument for a reason: it makes the money
 * check part of the call itself, so confirming without consulting the order is
 * not something a caller can do by forgetting. It must be exactly `paid` - a
 * refunded order is not a confirmable one.
 */
export function confirmBooking(
  booking: Booking,
  input: ConfirmBookingInput,
  now: Date,
): TransitionResult<Booking> {
  if (input.orderPaymentStatus !== "paid") {
    throw new UnpaidConfirmationError(booking.id, input.orderPaymentStatus);
  }
  const changed = assertTransition("Booking", BOOKING_TRANSITIONS, booking.status, "confirmed");
  if (!changed) return { entity: booking, changed: false };

  return {
    entity: {
      ...booking,
      status: "confirmed",
      meetingUrl: input.meetingUrl ?? booking.meetingUrl,
      calendarEventId: input.calendarEventId ?? booking.calendarEventId,
      updatedAt: now,
    },
    changed: true,
  };
}

/**
 * Payment succeeded but the slot did not survive.
 *
 * The booking returns to awaiting_schedule and its times are cleared, so
 * nothing downstream can read a slot the calendar no longer holds. The order
 * stays paid: the customer is owed a session, not a second charge.
 */
export function releaseBookingSlot(booking: Booking, now: Date): TransitionResult<Booking> {
  const changed = assertTransition(
    "Booking",
    BOOKING_TRANSITIONS,
    booking.status,
    "awaiting_schedule",
  );
  if (!changed) return { entity: booking, changed: false };

  return {
    entity: {
      ...booking,
      status: "awaiting_schedule",
      scheduledStart: null,
      scheduledEnd: null,
      calendarEventId: null,
      meetingUrl: null,
      updatedAt: now,
    },
    changed: true,
  };
}

function statusOnly(booking: Booking, to: BookingStatus, now: Date): TransitionResult<Booking> {
  const changed = assertTransition("Booking", BOOKING_TRANSITIONS, booking.status, to);
  if (!changed) return { entity: booking, changed: false };
  return { entity: { ...booking, status: to, updatedAt: now }, changed: true };
}

/** The session happened. */
export function completeBooking(booking: Booking, now: Date): TransitionResult<Booking> {
  return statusOnly(booking, "completed", now);
}

/** The customer did not attend. Distinct from cancelled: the slot was consumed. */
export function markBookingNoShow(booking: Booking, now: Date): TransitionResult<Booking> {
  return statusOnly(booking, "no_show", now);
}

/** Cancelled before it happened. Any refund is a separate decision on the Order. */
export function cancelBooking(booking: Booking, now: Date): TransitionResult<Booking> {
  return statusOnly(booking, "cancelled", now);
}
