import {
  SlotUnavailableError,
  type SchedulingProvider,
  type TimeSlot,
} from "@/domain/scheduling/provider";
import { logger } from "@/lib/logger";

/**
 * Block the real calendar for a hold the database has already taken.
 *
 * The database hold is the guard that matters inside our own system: two
 * customers cannot hold the same time, whatever the calendar says. The
 * calendar event is the guard for the OTHER direction - it stops the founder
 * putting something personal on top of a slot a customer is paying for. So
 * the database goes first, and the calendar is asked second.
 *
 * Three outcomes, and the difference between the last two is the point:
 *
 *   blocked      the calendar has a tentative event; attach its id to the hold.
 *   unavailable  the calendar says the time has gone since it was offered -
 *                somebody added an appointment in the last minute. Give the
 *                database hold back and offer another slot. Normal, not an
 *                error.
 *   unblocked    the calendar could not be reached. The database hold still
 *                protects the slot inside our own system, so checkout goes
 *                ahead; confirmation will create the event later. Logged at
 *                error level, never silent - a calendar that is down is worth
 *                knowing about, and a sale is not worth losing over it.
 */

export type CalendarHoldOutcome =
  | { readonly kind: "blocked"; readonly calendarEventId: string }
  | { readonly kind: "unavailable" }
  | { readonly kind: "unblocked"; readonly reason: string };

export interface BlockCalendarInput {
  readonly provider: SchedulingProvider;
  readonly holdId: string;
  readonly slot: TimeSlot;
  readonly subject: string;
  readonly attendeeName: string;
  readonly attendeeEmail: string;
}

export async function blockCalendar(input: BlockCalendarInput): Promise<CalendarHoldOutcome> {
  try {
    const event = await input.provider.holdSlot({
      slot: input.slot,
      subject: input.subject,
      attendeeName: input.attendeeName,
      attendeeEmail: input.attendeeEmail,
      holdReference: input.holdId,
    });
    return { kind: "blocked", calendarEventId: event.externalId };
  } catch (error) {
    if (error instanceof SlotUnavailableError) return { kind: "unavailable" };

    const reason = error instanceof Error ? error.message : String(error);
    logger.error(
      "the calendar could not be blocked for a hold - the database hold still protects the slot, and confirmation will create the event",
      { holdId: input.holdId, error: reason },
    );
    return { kind: "unblocked", reason };
  }
}
