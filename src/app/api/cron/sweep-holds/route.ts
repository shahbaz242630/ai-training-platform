import { NextResponse } from "next/server";
import { withTransaction } from "@/data/db";
import { claimExpiredHolds } from "@/data/slot-holds";
import { countPaidButUnscheduled } from "@/data/audit-events";
import { recordAudit } from "@/lib/audit";
import { authoriseCronRequest } from "@/lib/cron-auth";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Release the slots nobody paid for.
 *
 * A hold blocks a sellable time for fifteen minutes. Expiry already applies
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
      The tentative calendar events belong here: an expired hold whose event
      survives leaves the slot blocked on the real calendar even though we
      have released it. Every hold written so far carries a null event id (the
      scheduling provider is still the in-memory mock), so there is nothing to
      delete yet - and this counts them rather than pretending otherwise, so
      the day Graph lands the gap is visible instead of silent.
    */
    const awaitingCalendarRelease = expired.filter((hold) => hold.calendarEventId !== null).length;

    if (expired.length > 0) {
      logger.info("expired slot holds swept", {
        expired: expired.length,
        awaitingCalendarRelease,
      });
    }

    return NextResponse.json({
      ok: true,
      sweptAt: now.toISOString(),
      expired: expired.length,
      awaitingCalendarRelease,
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
