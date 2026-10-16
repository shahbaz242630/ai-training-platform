import {
  adoptRestoredEvents,
  anyBookingChanged,
  findCalendarProblems,
  listWatchedBookings,
  looksMisconfigured,
  type CalendarProblem,
  type RestoredEvent,
} from "@/data/calendar-watch";
import {
  reconcileDeskAlerts,
  type DeskAlertReport,
  type TransactionRunner,
} from "@/data/desk-alerts";
import { renderCalendarEventChanged } from "@/components/emails/desk-alerts";
import type { EmailProvider } from "@/domain/messaging/provider";
import type { SchedulingProvider } from "@/domain/scheduling/provider";
import { logger } from "@/lib/logger";

/**
 * The Outlook watch, as one step of the five-minute sweep: a booked
 * session's calendar event deleted, cancelled or moved by hand is emailed to
 * the desk, again each day while it lasts, and closed quietly once the
 * calendar matches again or the session has ended. Alert only: nothing is
 * changed for the customer (founder, session 96).
 *
 * The rule that matters most: unless the calendar was read completely and
 * in time, NOTHING is reconciled. Reconciling closes every open alert that
 * is not in the list it is given, so an empty or partial answer after a
 * failed read would close real alerts with nobody having acted.
 */

/**
 * Longer than any healthy read, far shorter than a stuck one. Graph retries
 * with sleeps, so a bad minute could otherwise hold the step for minutes and
 * let the next sweep overlap it. A late run working from an older read can
 * still close an alert a newer run opened; the next run reopens it, so the
 * worst case is a second "first" email, never a missed one.
 */
export const CALENDAR_WATCH_DEADLINE_MS = 60_000;

export interface CalendarWatchDeps {
  readonly transaction: TransactionRunner;
  /** Asked for only when there is a booking to check, so a quiet run needs no calendar set up. */
  readonly calendar: () => Pick<SchedulingProvider, "eventsBetween" | "getEvent">;
  readonly email: () => EmailProvider;
  readonly clock: () => Date;
  readonly deskAddress: string;
  readonly deadlineMs?: number;
}

export type CalendarWatchReport =
  | {
      readonly checked: number;
      readonly gone: number;
      readonly moved: number;
      /** Bookings moved onto their event's new id after a restore from Deleted Items. */
      readonly adopted: number;
      readonly deskAlerts: DeskAlertReport;
    }
  | { readonly skipped: string }
  | { readonly error: string };

class DeadlinePassed extends Error {
  constructor() {
    super("the Outlook watch ran past its deadline");
    this.name = "DeadlinePassed";
  }
}

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlinePassed()), ms);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export async function watchCalendar(deps: CalendarWatchDeps): Promise<CalendarWatchReport> {
  try {
    const bookings = await deps.transaction((runner) => listWatchedBookings(runner, deps.clock()));

    let problems: CalendarProblem[] = [];
    let restored: RestoredEvent[] = [];
    if (bookings.length > 0) {
      let calendar;
      try {
        calendar = deps.calendar();
      } catch (error) {
        logger.error("the calendar is not configured, so the Outlook watch cannot run", {
          error: (error as Error).message,
        });
        return { error: "calendar not configured" };
      }
      try {
        ({ problems, restored } = await withDeadline(
          findCalendarProblems(bookings, calendar),
          deps.deadlineMs ?? CALENDAR_WATCH_DEADLINE_MS,
        ));
      } catch (error) {
        // The name only: a Graph error's message can repeat what was asked.
        logger.error("the Outlook watch could not read the calendar; it will run again", {
          error: (error as Error).name,
        });
        return { error: "calendar could not be read" };
      }
    }

    const gone = problems.filter((p) => p.kind === "gone").length;
    if (looksMisconfigured(bookings.length, gone)) {
      logger.error(
        "THE OUTLOOK WATCH SEES MOST EVENTS MISSING - check the calendar mailbox setting " +
          "before anything else. Stored event ids do not survive a mailbox change.",
        { checked: bookings.length, missing: gone },
      );
      return { error: "calendar looks misconfigured" };
    }

    const problemBookings = bookings.filter((b) =>
      problems.some((p) => p.bookingId === b.bookingId),
    );
    if (await deps.transaction((runner) => anyBookingChanged(runner, problemBookings))) {
      return { skipped: "a booking changed during the check" };
    }

    if (problems.length > 0) {
      logger.error("A BOOKED SESSION'S CALENDAR EVENT WAS DELETED OR MOVED - the desk is told", {
        bookings: problems.map((p) => ({ bookingId: p.bookingId, kind: p.kind })),
      });
    }

    const deskAlerts = await reconcileDeskAlerts(
      "calendar_event_changed",
      problems.map((problem) => ({
        subjectKey: `booking:${problem.bookingId}`,
        render: (reminder) => renderCalendarEventChanged(problem, reminder),
      })),
      { email: deps.email, transaction: deps.transaction, clock: deps.clock },
      deps.deskAddress,
    );

    // A restored event has a new id. The booking and its hold follow it, or a
    // withdrawal would delete the old id (already gone) and leave the meeting.
    const adopted =
      restored.length === 0
        ? 0
        : await deps.transaction((runner) => adoptRestoredEvents(runner, restored, deps.clock()));
    return { checked: bookings.length, gone, moved: problems.length - gone, adopted, deskAlerts };
  } catch (error) {
    logger.error("the Outlook watch failed; it will run again next time", {
      error: (error as Error).name,
    });
    return { error: "calendar watch failed" };
  }
}
