import type { Interval } from "@/lib/time";

/**
 * The scheduling port.
 *
 * Everything that needs a calendar talks to this interface, never to a vendor
 * SDK. A page component that calls Microsoft Graph directly cannot be tested
 * without a tenant, cannot be run by a contributor who has no credentials, and
 * ties the booking flow to one vendor. Two implementations exist behind it: a
 * mock used by tests and by local development, and later a real one.
 *
 * The method set follows the sequence this product actually needs:
 *
 *     hold  ->  pay  ->  confirm
 *
 * A slot is held with a *tentative* calendar event before payment, so the real
 * calendar is blocked while the customer is entering a card. Only a verified
 * payment promotes it to confirmed. A scheduling API that confirms on its own
 * submit cannot express this, which is why the shape below is the shape it is.
 */

/** A candidate or booked period. Both instants are UTC. */
export type TimeSlot = Interval;

export interface AvailabilityQuery {
  /** Search window, UTC. */
  readonly from: Date;
  readonly to: Date;
  /** How long the session runs, which decides whether a slot can hold it. */
  readonly durationMinutes: number;
}

export type ExternalEventStatus = "tentative" | "confirmed" | "cancelled";

export interface ExternalEvent {
  /** The provider's own id. Stored so the event can be found again later. */
  readonly externalId: string;
  readonly status: ExternalEventStatus;
  readonly start: Date;
  readonly end: Date;
  /**
   * The join link. Null while tentative: a meeting link is something the
   * customer is sent once the session is real, and sending one before payment
   * is confirmed would be telling them they have a session they do not have.
   */
  readonly meetingUrl: string | null;
}

export interface HoldSlotInput {
  readonly slot: TimeSlot;
  /** What appears on the calendar, e.g. the session title. */
  readonly subject: string;
  readonly attendeeName: string;
  readonly attendeeEmail: string;
}

/** Base type, so a caller can catch every scheduling failure in one place. */
export class SchedulingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchedulingError";
  }
}

/**
 * The slot was taken between being offered and being held.
 *
 * Distinct from a general failure because it is not an error in the ordinary
 * sense - it is a race two customers can legitimately lose, and the response
 * is to offer another slot rather than to alert anyone.
 */
export class SlotUnavailableError extends SchedulingError {
  readonly slot: TimeSlot;

  constructor(slot: TimeSlot) {
    super(`The slot at ${slot.start.toISOString()} is no longer available`);
    this.name = "SlotUnavailableError";
    this.slot = slot;
  }
}

/** The provider has no event with that id - it was deleted, or never existed. */
export class EventNotFoundError extends SchedulingError {
  readonly externalId: string;

  constructor(externalId: string) {
    super(`No calendar event with id "${externalId}"`);
    this.name = "EventNotFoundError";
    this.externalId = externalId;
  }
}

export interface SchedulingProvider {
  /** Bookable slots in the window, already filtered by working hours, buffers and conflicts. */
  listAvailability(query: AvailabilityQuery): Promise<readonly TimeSlot[]>;

  /**
   * Block the slot with a tentative event, before payment.
   *
   * Re-checks availability at the moment of holding rather than trusting what
   * was offered, and throws `SlotUnavailableError` if it lost the race.
   */
  holdSlot(input: HoldSlotInput): Promise<ExternalEvent>;

  /** Payment verified: promote the tentative event and issue the meeting link. */
  confirmSlot(externalId: string): Promise<ExternalEvent>;

  /**
   * Give the slot back - checkout abandoned, expired, or payment failed.
   *
   * Deliberately succeeds when the event is already gone. Releasing is
   * cleanup, usually running in a sweep that may retry, and cleanup that
   * throws on an already-clean state is cleanup that blocks the sweep behind it.
   */
  releaseSlot(externalId: string): Promise<void>;

  /** Cancel a session that was already confirmed. */
  cancelEvent(externalId: string): Promise<void>;

  /** Read an event back, for reconciling our state against the calendar. */
  getEvent(externalId: string): Promise<ExternalEvent | null>;
}
