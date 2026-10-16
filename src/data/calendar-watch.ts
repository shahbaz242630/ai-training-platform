import type { QueryRunner } from "./db";
import type { ExternalEvent, SchedulingProvider } from "@/domain/scheduling/provider";
import type { Interval } from "@/lib/time";

/**
 * The Outlook watch (KC B17): a booked session whose calendar event was
 * deleted, cancelled or moved by hand in Outlook. Nothing in the booking app
 * notices that by itself, and the customer, whose reminders come from the
 * database, would join a meeting nobody else attends. Found here, told to
 * the desk by the sweep; nothing is ever changed for the customer.
 *
 * What Microsoft does, measured on the real mailbox (spike S1, 2026-10-16):
 * an event moved in Outlook keeps its id; one deleted goes to Deleted Items
 * and its id stops resolving; one restored from there comes back with a NEW
 * id, the same times and the same Teams link; and the calendar view leaves
 * the Teams link out, so a link is only ever learnt by reading one event.
 */

/** A confirmed session that has not ended, as the watch sees it. */
export interface WatchedBooking {
  readonly bookingId: string;
  readonly calendarEventId: string;
  readonly start: Date;
  readonly end: Date;
  /** The Teams link the customer was sent. A restored event is recognised by it. */
  readonly meetingUrl: string | null;
  readonly calendarMoveDue: boolean;
}

/** What is wrong, for the desk. Ids and times only: never the customer. */
export type CalendarProblem =
  | { readonly bookingId: string; readonly kind: "gone"; readonly booked: Interval }
  | {
      readonly bookingId: string;
      readonly kind: "moved";
      readonly booked: Interval;
      readonly calendar: Interval;
    };

/**
 * A booking's event restored from Deleted Items, under the new id it came
 * back with. The booking and its hold still carry the old id, and everything
 * that acts on the event (a withdrawal deleting it, a move, this watch) goes
 * by that id; left there, a withdrawal would delete nothing and leave the
 * restored meeting on the calendar (staging, 2026-10-16).
 */
export interface RestoredEvent {
  readonly bookingId: string;
  readonly fromId: string;
  readonly toId: string;
}

export interface CalendarFindings {
  readonly problems: CalendarProblem[];
  readonly restored: RestoredEvent[];
}

/** At most this many single-event reads a run; the rest count as gone, the safe direction. */
export const MAX_FOLLOW_UPS_PER_RUN = 20;

/**
 * A move waits for the move step to reach the calendar, and meanwhile its
 * event shows the old time on purpose. One still waiting after this long is
 * stuck, and watched again, so a move that keeps failing cannot hide its
 * booking from the watch for good.
 */
export const STUCK_MOVE_MS = 60 * 60_000;

/**
 * Every confirmed session that has not ended. No LIMIT: the desk alerts
 * close every open alert missing from what they are given, so a capped list
 * would close and reopen alerts run after run.
 */
export async function listWatchedBookings(
  runner: QueryRunner,
  now: Date,
): Promise<WatchedBooking[]> {
  const result = await runner.query<{
    id: string;
    calendar_event_id: string;
    scheduled_start: Date;
    scheduled_end: Date;
    meeting_url: string | null;
    calendar_move_due: boolean;
  }>(
    `select id, calendar_event_id, scheduled_start, scheduled_end, meeting_url, calendar_move_due
       from bookings
      where status = 'confirmed' and calendar_event_id is not null
        and scheduled_start is not null and scheduled_end is not null
        and scheduled_end > $1
        and (not calendar_move_due or updated_at < $2)
      order by scheduled_start`,
    [now, new Date(now.getTime() - STUCK_MOVE_MS)],
  );
  return result.rows.map((row) => ({
    bookingId: row.id,
    calendarEventId: row.calendar_event_id,
    start: row.scheduled_start,
    end: row.scheduled_end,
    meetingUrl: row.meeting_url,
    calendarMoveDue: row.calendar_move_due,
  }));
}

/**
 * Whether any of these bookings changed since they were read: cancelled,
 * moved, given another event, or flagged for a move. Checked after the
 * calendar read, so a change landing mid-run is never reported as a problem.
 */
export async function anyBookingChanged(
  runner: QueryRunner,
  before: readonly WatchedBooking[],
): Promise<boolean> {
  if (before.length === 0) return false;
  const result = await runner.query<{
    id: string;
    status: string;
    calendar_event_id: string | null;
    scheduled_start: Date | null;
    scheduled_end: Date | null;
    calendar_move_due: boolean;
  }>(
    `select id, status, calendar_event_id, scheduled_start, scheduled_end, calendar_move_due
       from bookings where id = any($1::uuid[])`,
    [before.map((b) => b.bookingId)],
  );
  const now = new Map(result.rows.map((row) => [row.id, row]));
  return before.some((b) => {
    const row = now.get(b.bookingId);
    return (
      row === undefined ||
      row.status !== "confirmed" ||
      row.calendar_event_id !== b.calendarEventId ||
      row.scheduled_start?.getTime() !== b.start.getTime() ||
      row.scheduled_end?.getTime() !== b.end.getTime() ||
      row.calendar_move_due !== b.calendarMoveDue
    );
  });
}

/**
 * Point each booking, and its own hold, at the event it was restored as.
 * Only where both still carry the id the calendar was read against and the
 * booking is still confirmed: a booking withdrawn, moved or given another
 * event meanwhile is left alone. Returns how many bookings followed.
 */
export async function adoptRestoredEvents(
  runner: QueryRunner,
  restored: readonly RestoredEvent[],
  now: Date,
): Promise<number> {
  let adopted = 0;
  for (const r of restored) {
    const booking = await runner.query<{ order_id: string }>(
      `update bookings set calendar_event_id = $3, updated_at = $4
        where id = $1 and status = 'confirmed' and calendar_event_id = $2
        returning order_id`,
      [r.bookingId, r.fromId, r.toId, now],
    );
    const orderId = booking.rows[0]?.order_id;
    if (orderId === undefined) continue;
    await runner.query(
      `update slot_holds set calendar_event_id = $3
        where order_id = $1 and calendar_event_id = $2`,
      [orderId, r.fromId, r.toId],
    );
    adopted += 1;
  }
  return adopted;
}

/** Compared at whole seconds: a time typed in Outlook carries none, Graph sends seven digits. */
const seconds = (instant: Date) => Math.floor(instant.getTime() / 1000);

function sameTimes(a: Interval, b: Interval): boolean {
  return seconds(a.start) === seconds(b.start) && seconds(a.end) === seconds(b.end);
}

/**
 * Compare the bookings with the calendar. One list read for the whole
 * window, then a read by id only for a booking whose event is not there.
 * Any failure is thrown, never answered: an empty or partial answer would
 * close real alerts.
 */
export async function findCalendarProblems(
  bookings: readonly WatchedBooking[],
  calendar: Pick<SchedulingProvider, "eventsBetween" | "getEvent">,
): Promise<CalendarFindings> {
  if (bookings.length === 0) return { problems: [], restored: [] };
  const from = new Date(Math.min(...bookings.map((b) => b.start.getTime())));
  const to = new Date(Math.max(...bookings.map((b) => b.end.getTime())));
  const inView = await calendar.eventsBetween(from, to);
  const byId = new Map(inView.map((e) => [e.externalId, e]));
  const storedIds = new Set(bookings.map((b) => b.calendarEventId));

  let followUps = 0;
  const read = async (id: string): Promise<ExternalEvent | null | "over_budget"> => {
    if (followUps >= MAX_FOLLOW_UPS_PER_RUN) return "over_budget";
    followUps += 1;
    return calendar.getEvent(id);
  };

  const problems: CalendarProblem[] = [];
  const restored: RestoredEvent[] = [];
  for (const booking of bookings) {
    const booked = { start: booking.start, end: booking.end };
    const gone = { bookingId: booking.bookingId, kind: "gone", booked } as const;
    const seen = byId.get(booking.calendarEventId);

    if (seen !== undefined) {
      if (seen.status === "cancelled") problems.push(gone);
      else if (!sameTimes(seen, booked)) problems.push(movedTo(booking, seen));
      continue;
    }

    // Not in the window: moved outside it, or deleted.
    const stored = await read(booking.calendarEventId);
    if (stored === "over_budget") {
      problems.push(gone);
      continue;
    }
    if (stored !== null && stored.status !== "cancelled") {
      if (!sameTimes(stored, booked)) problems.push(movedTo(booking, stored));
      continue;
    }

    // Deleted, or cancelled. Restored from Deleted Items, it is at the booked times with the same Teams link.
    const restoredAs = await restoredElsewhere(booking, inView, storedIds, read);
    if (restoredAs === null) problems.push(gone);
    else
      restored.push({
        bookingId: booking.bookingId,
        fromId: booking.calendarEventId,
        toId: restoredAs,
      });
  }
  return { problems, restored };
}

function movedTo(booking: WatchedBooking, event: ExternalEvent): CalendarProblem {
  return {
    bookingId: booking.bookingId,
    kind: "moved",
    booked: { start: booking.start, end: booking.end },
    calendar: { start: event.start, end: event.end },
  };
}

/** The id of a live event at the booked times, under another id, carrying the booking's Teams link. */
async function restoredElsewhere(
  booking: WatchedBooking,
  inView: readonly ExternalEvent[],
  storedIds: ReadonlySet<string>,
  read: (id: string) => Promise<ExternalEvent | null | "over_budget">,
): Promise<string | null> {
  if (booking.meetingUrl === null) return null;
  const candidates = inView.filter(
    (e) => e.status !== "cancelled" && !storedIds.has(e.externalId) && sameTimes(e, booking),
  );
  for (const candidate of candidates) {
    const full = await read(candidate.externalId);
    if (full === "over_budget") return null;
    if (full !== null && full.meetingUrl === booking.meetingUrl) return candidate.externalId;
  }
  return null;
}

/**
 * Half or more of at least four sessions missing at once is not a run of
 * deletions: it is the wrong mailbox, or a tenant change that left every
 * stored id behind. Raised once, as a configuration fault, instead of an
 * email per booking.
 */
export function looksMisconfigured(selected: number, gone: number): boolean {
  return selected >= 4 && gone * 2 >= selected;
}
