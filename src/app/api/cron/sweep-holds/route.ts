import { NextResponse } from "next/server";
import { withTransaction } from "@/data/db";
import {
  claimExpiredHolds,
  claimHoldsAwaitingCalendarRelease,
  markCalendarReleased,
} from "@/data/slot-holds";
import { confirmBookingOnCalendar, listBookingsAwaitingConfirmation } from "@/data/confirmation";
import { getSchedulingProvider } from "@/domain/scheduling/factory";
import type { SchedulingProvider } from "@/domain/scheduling/provider";
import { countPaidButUnscheduled } from "@/data/audit-events";
import { recordAudit } from "@/lib/audit";
import { authoriseCronRequest } from "@/lib/cron-auth";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Release the slots nobody paid for.
 *
 * A hold blocks a sellable time until it expires. Expiry already applies
 * when availability is READ, so an abandoned checkout never keeps a slot off
 * the calendar - this job does the part that reading cannot: settling the row
 * and deleting the tentative calendar event that still blocks the real diary.
 *
 * Called by Supabase Cron every five minutes over plain HTTP, which is what
 * keeps the schedule host-agnostic: no platform cron product, no proprietary
 * runtime, just a URL and a secret.
 *
 * Idempotent by construction. Running it twice, or twice at once, expires
 * nothing twice - the claim step takes only rows no other run holds.
 */

/*
  Never prerendered and never cached. A cached sweep result would be a job
  that appears to run and does nothing, which is the worst of both.
*/
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const auth = authoriseCronRequest(request.headers.get("authorization"), serverEnv().CRON_SECRET);

  if (auth === "not_configured") {
    /*
      Deliberately a server error, not a 401. The caller did nothing wrong -
      WE are misconfigured, and a 401 here would send somebody hunting for a
      wrong secret instead of a missing one.
    */
    logger.error("cron secret is not configured, so the sweep cannot run");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  if (auth === "unauthorised") {
    // No detail. A stranger learns only that they were refused.
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const now = new Date();

  try {
    const expired = await withTransaction((runner) => claimExpiredHolds(runner, now));

    if (expired.length > 0) {
      await recordAudit({
        action: "booking.hold_released",
        actor: { kind: "system", process: "sweep-holds" },
        subject: `sweep:${now.toISOString()}`,
        metadata: { expired: expired.length },
      });
    }

    /*
      THE STATE THAT NEEDS A HUMAN, checked on a timer.

      An order that is paid while its booking still waits to be scheduled means
      the money is ours and the customer appears in no calendar. It was
      previously visible only as one console.error line at the moment it
      happened - so if nobody was watching stdout in that second, nobody ever
      knew. This job already runs every five minutes; asking the question here
      costs one indexed count and turns a missed line into a standing alarm.
    */
    const paidButUnscheduled = await withTransaction((runner) => countPaidButUnscheduled(runner));

    if (paidButUnscheduled > 0) {
      logger.error(
        "PAID BUT NOT SCHEDULED - customers have paid and have no session booked. " +
          "Reschedule by hand. DO NOT charge again.",
        { count: paidButUnscheduled },
      );
    }

    /*
      The tentative calendar events. An expired or released hold whose event
      survives leaves the slot blocked on the REAL calendar, which is what
      availability now reads - so the time is off sale for everyone until the
      event goes. Deleted here, every run, until each one is recorded as gone.
    */
    const calendar = await releaseCalendarEvents(now);

    /*
      Bookings that were paid for but whose calendar confirmation did not
      finish - the calendar was unreachable in the seconds after settlement,
      or the join link had not been issued yet. Tried again here.
    */
    const confirmations = await retryConfirmations(now);

    if (expired.length > 0) {
      logger.info("expired slot holds swept", { expired: expired.length });
    }

    return NextResponse.json({
      ok: true,
      sweptAt: now.toISOString(),
      expired: expired.length,
      calendarEventsReleased: calendar.released,
      calendarEventsStillBlocking: calendar.failed,
      confirmations,
      // Reported on every run, so the number is visible to whatever calls this
      // rather than only in a log somebody has to go looking for.
      paidButUnscheduled,
    });
  } catch (error) {
    /*
      A failed sweep must look failed. Returning 200 with a zero count would
      make an outage indistinguishable from a quiet five minutes, and this is
      exactly the shape the ZAP checker lesson warned about: a missing result
      is a failure, never a pass.
    */
    logger.error("slot hold sweep failed", { error: (error as Error).message });
    return NextResponse.json({ error: "Sweep failed" }, { status: 500 });
  }
}

/** The calendar, or null with the reason logged. Unconfigured is not an outage of the sweep. */
function calendarOrNull(purpose: string): SchedulingProvider | null {
  try {
    return getSchedulingProvider();
  } catch (error) {
    logger.error(`the calendar is not configured, so ${purpose} must wait`, {
      error: (error as Error).message,
    });
    return null;
  }
}

async function releaseCalendarEvents(now: Date): Promise<{ released: number; failed: number }> {
  const pending = await withTransaction((runner) => claimHoldsAwaitingCalendarRelease(runner));
  if (pending.length === 0) return { released: 0, failed: 0 };

  const provider = calendarOrNull("tentative events cannot be deleted");
  if (provider === null) return { released: 0, failed: pending.length };

  let released = 0;
  let failed = 0;
  for (const hold of pending) {
    try {
      await provider.releaseSlot(hold.calendarEventId);
      await withTransaction((runner) => markCalendarReleased(runner, hold.id, now));
      released += 1;
    } catch (error) {
      failed += 1;
      logger.error("a tentative calendar event could not be deleted and still blocks its slot", {
        holdId: hold.id,
        calendarEventId: hold.calendarEventId,
        error: (error as Error).message,
      });
    }
  }
  return { released, failed };
}

async function retryConfirmations(
  now: Date,
): Promise<{ attempted: number; confirmed: number; slotLost: number; failed: number }> {
  const bookingIds = await withTransaction((runner) =>
    listBookingsAwaitingConfirmation(runner, 20),
  );
  const counts = { attempted: bookingIds.length, confirmed: 0, slotLost: 0, failed: 0 };
  if (bookingIds.length === 0) return counts;

  const provider = calendarOrNull("paid bookings cannot be confirmed");
  if (provider === null) return { ...counts, failed: bookingIds.length };

  for (const bookingId of bookingIds) {
    try {
      const result = await confirmBookingOnCalendar({
        bookingId,
        provider,
        now,
        transaction: withTransaction,
      });
      if (result === "confirmed") counts.confirmed += 1;
      if (result === "slot_lost") counts.slotLost += 1;
    } catch (error) {
      counts.failed += 1;
      logger.error("a paid booking could not be confirmed on the calendar; will retry", {
        bookingId,
        error: (error as Error).message,
      });
    }
  }
  return counts;
}
