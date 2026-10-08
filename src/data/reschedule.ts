import type { QueryRunner } from "./db";
import { insertAuditEvent } from "./audit-events";
import { queueForBooking } from "./communications";
import { decideReschedule, type RescheduleRefusal } from "@/domain/booking/reschedule";
import type { BookingStatus } from "@/domain/booking/booking";
import { messagesOnConfirmation } from "@/domain/messaging/schedule";
import type { TemplateKey } from "@/domain/messaging/sending-policy";
import { EventNotFoundError, type SchedulingProvider } from "@/domain/scheduling/provider";
import { logger } from "@/lib/logger";

/**
 * Moving a confirmed session to a new time, in one transaction.
 *
 * The double-booking guarantees are database constraints, so the move goes
 * through them rather than around them: the new time is claimed as a
 * converted slot hold (refused if it overlaps any live hold) and the booking's
 * own times change (refused if they overlap another session). Either refusal
 * throws, the caller's transaction rolls back, and `isMoveCollision` tells the
 * caller it means "that time has just gone".
 *
 * The calendar event is not touched here - it cannot join a transaction. The
 * booking is flagged `calendar_move_due` and the sweep moves the event until
 * it succeeds. The old hold gives up its event (calendar_event_id cleared) so
 * the release sweep, which deletes the events of released holds, can never
 * delete the event this booking still needs.
 *
 * Call inside a transaction. The row lock taken first makes two concurrent
 * moves of the same booking queue behind each other, and the second then
 * sees the first one's count and is refused.
 */

export type MoveOutcome =
  | { readonly kind: "moved"; readonly start: Date; readonly end: Date }
  | { readonly kind: "refused"; readonly reason: RescheduleRefusal | "not_found" };

export interface MoveInput {
  readonly bookingId: string;
  readonly newSlot: { readonly start: Date; readonly end: Date };
  readonly now: Date;
}

/** The messages whose moment depends on the session's time. */
const TIMED: readonly TemplateKey[] = ["reminder_24h", "reminder_3h", "follow_up"];

export async function moveBooking(runner: QueryRunner, input: MoveInput): Promise<MoveOutcome> {
  const found = await runner.query<{
    status: BookingStatus;
    scheduled_start: Date | null;
    scheduled_end: Date | null;
    reschedule_count: number;
    calendar_event_id: string | null;
    order_id: string;
    customer_id: string;
  }>(
    `select b.status, b.scheduled_start, b.scheduled_end, b.reschedule_count,
            b.calendar_event_id, b.order_id, o.customer_id
       from bookings b
       join orders o on o.id = b.order_id
      where b.id = $1
      for update of b`,
    [input.bookingId],
  );
  const booking = found.rows[0];
  if (!booking) return { kind: "refused", reason: "not_found" };

  const decision = decideReschedule({
    status: booking.status,
    scheduledStart: booking.scheduled_start,
    scheduledEnd: booking.scheduled_end,
    rescheduleCount: booking.reschedule_count,
    newSlot: input.newSlot,
    now: input.now,
  });
  if (!decision.ok) return { kind: "refused", reason: decision.reason };

  const { start, end } = input.newSlot;

  // The old time is free again. Its event moves with the booking, so the
  // released hold must not still claim it.
  const released = await runner.query<{ id: string }>(
    `update slot_holds
        set status = 'released', calendar_event_id = null
      where order_id = $1 and status = 'converted' and slot_start = $2 and slot_end = $3
      returning id`,
    [booking.order_id, booking.scheduled_start, booking.scheduled_end],
  );
  if (released.rows.length === 0) {
    // A booking placed by hand may have no hold behind it. The move is still
    // right; whoever looks at the old time on the calendar should know why.
    logger.warn("a moved booking had no paid hold on its old time to release", {
      bookingId: input.bookingId,
    });
  }

  // The new time, claimed under the same constraint every checkout goes through.
  await runner.query(
    `insert into slot_holds (slot_start, slot_end, order_id, calendar_event_id, expires_at, status)
     values ($1, $2, $3, $4, $5, 'converted')`,
    [start, end, booking.order_id, booking.calendar_event_id, input.now],
  );

  await runner.query(
    `update bookings
        set scheduled_start = $2, scheduled_end = $3,
            reschedule_count = reschedule_count + 1,
            calendar_move_due = (calendar_event_id is not null),
            updated_at = $4
      where id = $1`,
    [input.bookingId, start, end, input.now],
  );

  await retimeMessages(runner, input.bookingId, { start, end, now: input.now });
  await queueForBooking(runner, input.bookingId, [
    { templateKey: "reschedule_confirmation", scheduledFor: input.now },
  ]);

  await insertAuditEvent(runner, {
    action: "booking.rescheduled",
    actor: { kind: "customer", customerId: booking.customer_id },
    subject: `booking:${input.bookingId}`,
    metadata: {
      from: booking.scheduled_start?.toISOString() ?? null,
      to: start.toISOString(),
    },
    occurredAt: input.now.toISOString(),
  });

  return { kind: "moved", start, end };
}

/**
 * Reminders and the follow-up follow the session to its new time. One still
 * queued is moved; one whose new moment has passed is cancelled rather than
 * sent late; one already sent stays sent (each template goes once per
 * booking). One that was never queued but now applies is added.
 */
async function retimeMessages(
  runner: QueryRunner,
  bookingId: string,
  slot: { readonly start: Date; readonly end: Date; readonly now: Date },
): Promise<void> {
  const due = new Map(
    messagesOnConfirmation({ scheduledStart: slot.start, scheduledEnd: slot.end, now: slot.now })
      .filter((m) => TIMED.includes(m.templateKey))
      .map((m) => [m.templateKey, m.scheduledFor] as const),
  );

  for (const key of TIMED) {
    const when = due.get(key);
    if (when) {
      await runner.query(
        `update communication_log set scheduled_for = $3
          where booking_id = $1 and template_key = $2 and status = 'queued'`,
        [bookingId, key, when],
      );
    } else {
      await runner.query(
        `update communication_log set status = 'cancelled'
          where booking_id = $1 and template_key = $2 and status = 'queued'`,
        [bookingId, key],
      );
    }
  }

  await queueForBooking(
    runner,
    bookingId,
    [...due].map(([templateKey, scheduledFor]) => ({ templateKey, scheduledFor })),
  );
}

export interface BookingForManage {
  readonly status: BookingStatus;
  readonly sessionSlug: string;
  readonly scheduledStart: Date | null;
  readonly scheduledEnd: Date | null;
  readonly rescheduleCount: number;
  readonly customerTimezone: string;
}

/** What the manage page shows and decides with. Null for an unknown booking. */
export async function loadBookingForManage(
  runner: QueryRunner,
  bookingId: string,
): Promise<BookingForManage | null> {
  const result = await runner.query<{
    status: BookingStatus;
    session_slug: string;
    scheduled_start: Date | null;
    scheduled_end: Date | null;
    reschedule_count: number;
    customer_timezone: string;
  }>(
    `select status, session_slug, scheduled_start, scheduled_end, reschedule_count, customer_timezone
       from bookings where id = $1`,
    [bookingId],
  );
  const row = result.rows[0];
  return row
    ? {
        status: row.status,
        sessionSlug: row.session_slug,
        scheduledStart: row.scheduled_start,
        scheduledEnd: row.scheduled_end,
        rescheduleCount: row.reschedule_count,
        customerTimezone: row.customer_timezone,
      }
    : null;
}

export interface CalendarMoveDue {
  readonly bookingId: string;
  readonly calendarEventId: string;
  readonly start: Date;
  readonly end: Date;
}

/** Bookings whose times changed and whose calendar event has not caught up. */
export async function listCalendarMovesDue(
  runner: QueryRunner,
  limit: number,
): Promise<readonly CalendarMoveDue[]> {
  const result = await runner.query<{
    id: string;
    calendar_event_id: string;
    scheduled_start: Date;
    scheduled_end: Date;
  }>(
    `select id, calendar_event_id, scheduled_start, scheduled_end
       from bookings
      where calendar_move_due and status = 'confirmed' and calendar_event_id is not null
        and scheduled_start is not null and scheduled_end is not null
      order by updated_at
      limit $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    bookingId: row.id,
    calendarEventId: row.calendar_event_id,
    start: row.scheduled_start,
    end: row.scheduled_end,
  }));
}

export type CalendarMoveResult = "moved" | "event_missing" | "nothing_due";

type Transaction = <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;

/**
 * Bring one booking's calendar event to the booking's times.
 *
 * Run straight after a move, and by the sweep for anything that failed. A
 * calendar outage throws and leaves the flag set, so the next sweep tries
 * again. An event that no longer exists is not retried forever: the flag is
 * cleared and the caller raises it for a person, because a booked session
 * with no event means the coach's calendar does not show it at all.
 *
 * The flag is cleared only if the times are still the ones just written, so a
 * change in between is never marked as done.
 */
export async function syncCalendarMove(input: {
  readonly bookingId: string;
  readonly provider: Pick<SchedulingProvider, "moveEvent">;
  readonly transaction: Transaction;
}): Promise<CalendarMoveResult> {
  const due = await input.transaction(async (runner) => {
    const rows = await runner.query<{
      calendar_event_id: string;
      scheduled_start: Date;
      scheduled_end: Date;
    }>(
      `select calendar_event_id, scheduled_start, scheduled_end
         from bookings
        where id = $1 and calendar_move_due and status = 'confirmed'
          and calendar_event_id is not null
          and scheduled_start is not null and scheduled_end is not null`,
      [input.bookingId],
    );
    return rows.rows[0] ?? null;
  });
  if (due === null) return "nothing_due";

  let result: CalendarMoveResult = "moved";
  try {
    await input.provider.moveEvent(due.calendar_event_id, {
      start: due.scheduled_start,
      end: due.scheduled_end,
    });
  } catch (error) {
    if (!(error instanceof EventNotFoundError)) throw error;
    result = "event_missing";
  }

  await input.transaction((runner) =>
    runner.query(
      `update bookings set calendar_move_due = false
        where id = $1 and scheduled_start = $2 and scheduled_end = $3`,
      [input.bookingId, due.scheduled_start, due.scheduled_end],
    ),
  );
  return result;
}

const COLLISION_CONSTRAINTS = new Set([
  "slot_holds_no_overlapping_live_hold",
  "bookings_no_overlapping_session",
]);

/** The move lost a race for its new time: somebody else holds or booked it. */
export function isMoveCollision(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, constraint } = error as { code?: string; constraint?: string };
  return code === "23P01" && (constraint === undefined || COLLISION_CONSTRAINTS.has(constraint));
}
