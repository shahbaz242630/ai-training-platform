import { NextResponse } from "next/server";
import { withTransaction } from "@/data/db";
import {
  claimExpiredHolds,
  claimHoldsAwaitingCalendarRelease,
  markCalendarReleased,
} from "@/data/slot-holds";
import { confirmBookingOnCalendar, listBookingsAwaitingConfirmation } from "@/data/confirmation";
import { listCalendarMovesDue, syncCalendarMove } from "@/data/reschedule";
import { getSchedulingProvider } from "@/domain/scheduling/factory";
import type { SchedulingProvider } from "@/domain/scheduling/provider";
import { listPaidButUnscheduled, type PaidButUnscheduled } from "@/data/audit-events";
import {
  listRefundsNeedingAttention,
  refundWorkWaiting,
  type RefundNeedingAttention,
} from "@/data/refund-queries";
import { reconcileDeskAlerts, type DeskAlertReport } from "@/data/desk-alerts";
import {
  CHOOSE_TIME_LINK_DAYS,
  renderPaidBookingNeedsTime,
  renderRefundNeedsAttention,
} from "@/components/emails/desk-alerts";
import { TRAINING_BASE, supportEmail } from "@/config/site";
import { getEmailProvider } from "@/domain/messaging/factory";
import { issueDueRefunds, refreshPendingRefunds } from "@/data/refund-issuer";
import { getPaymentProvider } from "@/domain/payments/factory";
import { purgeExpiredPersonalData, type PurgeReport } from "@/data/retention";
import { readAppliedSchemaVersion, schemaStatus } from "@/data/schema-version";
import { recordAudit } from "@/lib/audit";
import { watchCalendar } from "./calendar-watch-step";
import { endAbandonedCheckouts } from "./abandoned-checkouts-step";
import { disputeStep, queueChooseNewTime } from "./dispute-step";
import { heartbeatFailed, heartbeatStep } from "./heartbeat-step";
import { reconcilePendingOrders } from "./reconcile-step";
import { declineUrlFor, withdrawalDecisionAlerts } from "./withdrawal-decision-step";
import { authoriseCronRequest } from "@/lib/cron-auth";
import { clientEnv, serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createManageToken } from "@/lib/manage-link";
import { addDays } from "@/lib/time";

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
    const waitingForTime = await withTransaction((runner) => listPaidButUnscheduled(runner));
    const paidButUnscheduled = waitingForTime.length;

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
    /*
      The database behind the code: a migration was never applied. Raised on
      every run until it is, instead of surfacing as a query failing in front
      of a customer.
    */
    const schema = schemaStatus(
      await withTransaction((runner) => readAppliedSchemaVersion(runner)),
    );
    if (!schema.current) {
      logger.error("DATABASE SCHEMA IS BEHIND THE CODE - run pnpm db:migrate", {
        expected: schema.expected,
        applied: schema.applied,
      });
    }

    const calendar = await releaseCalendarEvents(now);

    /*
      Bookings that were paid for but whose calendar confirmation did not
      finish - the calendar was unreachable in the seconds after settlement,
      or the join link had not been issued yet. Tried again here.
    */
    const confirmations = await retryConfirmations(now);

    /*
      Sessions a customer moved whose calendar event still shows the old time:
      the move commits in the database first, and the event follows here until
      it succeeds. Until then the coach's calendar is wrong, so this runs
      every time.
    */
    const calendarMoves = await applyCalendarMoves();

    /*
      The Outlook watch: a booked session whose event was deleted or moved by
      hand, told to the desk. After the moves above, so a move that just
      reached the calendar is not reported. Alert only, in its own failure.
    */
    const calendarWatch = await watchCalendar({
      transaction: withTransaction,
      calendar: getSchedulingProvider,
      email: getEmailProvider,
      clock: () => new Date(),
      deskAddress: supportEmail(),
    });

    /*
      Refunds owed for withdrawals, asked for here rather than on the public
      form, and refunds Stripe has gone quiet about, read again. In their own
      failure domain: a processor outage must not turn the whole sweep red.
    */
    const refunds = await refundOrReport(now);

    /*
      The refund alarm, on every run like the one above: money owed that has
      not gone back, or went back and then failed. Raised until a person
      refunds it by hand and the dashboard refund is recorded.
    */
    const attention = await withTransaction((runner) => listRefundsNeedingAttention(runner, now));
    const refundsNeedingAttention = attention.length;
    if (refundsNeedingAttention > 0) {
      logger.error(
        "REFUNDS NEED A PERSON - a refund owed has failed or is overdue. " +
          "Refund it by hand in the Stripe dashboard.",
        { count: refundsNeedingAttention },
      );
    }

    /*
      And told to a person: an email to the booking desk per refund, again
      each day while it lasts, closed quietly once it is gone. A log line is
      read by nobody; this is what makes the alarm reach somebody.
    */
    const deskAlerts = await deskAlertsOrReport(attention);

    // The customer who has paid and has no session time is sent their own link to choose one.
    const chooseTimeEmails = await queueChooseNewTime(
      waitingForTime,
      { transaction: withTransaction, clock: () => new Date() },
      Boolean(serverEnv().MANAGE_LINK_SECRET),
    );

    /*
      And the desk is told about the same customer (KC B8), read again after
      the queueing so it says truly whether the customer has been emailed. One
      whose email is still waiting to go is held back: the desk hears once it
      has gone, or failed, with words that match.
    */
    const paidBookingAlerts = await paidBookingAlertsOrReport(
      (await withTransaction((runner) => listPaidButUnscheduled(runner))).filter(
        (problem) => !problem.customerEmailPending,
      ),
    );

    // Orders whose payment event never arrived: asked about, settled, and the desk told.
    const reconciliation = await reconcilePendingOrders({
      provider: getPaymentProvider,
      transaction: withTransaction,
      clock: () => new Date(),
      email: getEmailProvider,
      desk: supportEmail,
    });

    // A checkout given up for another, still open at Stripe: ended, so it cannot be paid as well.
    const abandonedCheckouts = await endAbandonedCheckouts({
      provider: getPaymentProvider,
      transaction: withTransaction,
      clock: () => new Date(),
    });

    /*
      Disputes, after the settling above, so a dispute on an order settled
      this run is linked this run: the effects re-applied where work remains,
      and the desk told, with the deadline.
    */
    const disputes = await disputeStep({
      transaction: withTransaction,
      email: getEmailProvider,
      clock: () => new Date(),
      desk: supportEmail,
    });

    // And a withdrawal whose card is not from the UK or the EU, waiting for a person.
    const withdrawalDecisions = await withdrawalDecisionAlerts({
      transaction: withTransaction,
      email: getEmailProvider,
      clock: () => new Date(),
      desk: supportEmail,
      declineUrl: declineUrlFor,
    });

    /*
      What the privacy notice says we stop keeping, deleted on schedule. Every
      step is keyed on time, so a run with nothing due changes nothing.
    */
    const retention = await purgeOrReport(now);

    if (expired.length > 0) {
      logger.info("expired slot holds swept", { expired: expired.length });
    }

    // Last: tell the outside monitor this run happened, and whether anything is stuck.
    const heartbeat = await heartbeatStep(schema, now);

    return NextResponse.json({
      ok: true,
      heartbeat,
      sweptAt: now.toISOString(),
      expired: expired.length,
      calendarEventsReleased: calendar.released,
      calendarEventsStillBlocking: calendar.failed,
      calendarWatch,
      confirmations,
      calendarMoves,
      refunds,
      refundsNeedingAttention,
      deskAlerts,
      retention,
      // Reported on every run, so the number is visible to whatever calls this
      // rather than only in a log somebody has to go looking for.
      paidButUnscheduled,
      paidBookingAlerts,
      chooseTimeEmails,
      disputes,
      withdrawalDecisions,
      reconciliation,
      abandonedCheckouts,
      schema,
    });
  } catch (error) {
    /*
      A failed sweep must look failed. Returning 200 with a zero count would
      make an outage indistinguishable from a quiet five minutes, and this is
      exactly the shape the ZAP checker lesson warned about: a missing result
      is a failure, never a pass.
    */
    logger.error("slot hold sweep failed", { error: (error as Error).message });
    // The monitor hears it too: a sweep failing every run looks, from outside, like one that runs.
    await heartbeatFailed();
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

async function applyCalendarMoves(): Promise<{ moved: number; missing: number; failed: number }> {
  const due = await withTransaction((runner) => listCalendarMovesDue(runner, 20));
  const counts = { moved: 0, missing: 0, failed: 0 };
  if (due.length === 0) return counts;

  const provider = calendarOrNull("moved sessions cannot be moved on the calendar");
  if (provider === null) return { ...counts, failed: due.length };

  for (const booking of due) {
    try {
      const result = await syncCalendarMove({
        bookingId: booking.bookingId,
        provider,
        transaction: withTransaction,
      });
      if (result === "moved") counts.moved += 1;
      if (result === "event_missing") {
        counts.missing += 1;
        logger.error(
          "a moved session has no calendar event - put it back on the calendar by hand",
          { bookingId: booking.bookingId, calendarEventId: booking.calendarEventId },
        );
      }
    } catch (error) {
      counts.failed += 1;
      logger.error("a moved session's calendar event still shows the old time; will retry", {
        bookingId: booking.bookingId,
        error: (error as Error).message,
      });
    }
  }
  return counts;
}

type RefundReport =
  | (Awaited<ReturnType<typeof issueDueRefunds>> & {
      readonly refreshed: Awaited<ReturnType<typeof refreshPendingRefunds>>;
    })
  | { readonly waiting: false }
  | { readonly error: string };

/**
 * The refund step. Asks first whether there is anything to do, so a run with
 * no refunds never needs payments configured.
 */
async function refundOrReport(now: Date): Promise<RefundReport> {
  try {
    if (!(await withTransaction((runner) => refundWorkWaiting(runner, now)))) {
      return { waiting: false };
    }
    let provider;
    try {
      provider = getPaymentProvider();
    } catch (error) {
      logger.error("payments are not configured, so refunds owed must wait", {
        error: (error as Error).name,
      });
      return { error: "payments not configured" };
    }
    // A fresh clock for every claim and record, not this run's start.
    const deps = { provider, transaction: withTransaction, clock: () => new Date() };
    const issued = await issueDueRefunds(deps);
    const refreshed = await refreshPendingRefunds(deps);
    return { ...issued, refreshed };
  } catch (error) {
    /*
      The name only. A processor error's message can repeat what was sent,
      and nothing about a customer's payment belongs in the log.
    */
    logger.error("the refund step failed; it will run again next time", {
      error: (error as Error).name,
    });
    return { error: "refund step failed" };
  }
}

/**
 * The desk alerts for refunds, in their own failure: email being down must
 * not turn the sweep red. Nothing is recorded as sent unless it went, so a
 * failure here is simply tried again next run.
 */
async function deskAlertsOrReport(
  attention: readonly RefundNeedingAttention[],
): Promise<DeskAlertReport | { error: string }> {
  try {
    return await reconcileDeskAlerts(
      "refund_needs_attention",
      attention.map((refund) => ({
        subjectKey: `refund:${refund.refundId}`,
        render: (reminder) => renderRefundNeedsAttention(refund, reminder),
      })),
      { email: getEmailProvider, transaction: withTransaction, clock: () => new Date() },
      supportEmail(),
    );
  } catch (error) {
    logger.error("desk alerts could not be sent; they will be tried again next run", {
      error: (error as Error).name,
      // A database error's name is just "error"; its code (e.g. 23514) says which.
      code: (error as { code?: unknown }).code ?? null,
    });
    return { error: "desk alerts could not be sent" };
  }
}

/** The paid-but-no-time alerts, in their own failure for the same reason. Keyed by order. */
async function paidBookingAlertsOrReport(
  waiting: readonly PaidButUnscheduled[],
): Promise<DeskAlertReport | { error: string }> {
  try {
    return await reconcileDeskAlerts(
      "paid_booking_needs_time",
      waiting.map((problem) => ({
        subjectKey: `order:${problem.orderId}`,
        render: (reminder) =>
          renderPaidBookingNeedsTime(problem, reminder, chooseTimeUrlFor(problem, new Date())),
      })),
      { email: getEmailProvider, transaction: withTransaction, clock: () => new Date() },
      supportEmail(),
    );
  } catch (error) {
    logger.error("paid-booking desk alerts could not be sent; they will be tried again next run", {
      error: (error as Error).name,
      code: (error as { code?: unknown }).code ?? null,
    });
    return { error: "desk alerts could not be sent" };
  }
}

/**
 * The customer's link to choose a new time, for the desk to forward: the
 * Manage my booking page, which offers a paid booking that lost its time any
 * open time. Made fresh for every send. Null when there is no booking to give
 * a time to, the order is part-refunded (only a fully paid order confirms),
 * or no signing secret is set.
 */
function chooseTimeUrlFor(problem: PaidButUnscheduled, now: Date): string | null {
  const secret = serverEnv().MANAGE_LINK_SECRET;
  if (!secret || problem.bookingId === null || !problem.fullyPaid) return null;
  const token = createManageToken(
    { bookingId: problem.bookingId, expiresAt: addDays(now, CHOOSE_TIME_LINK_DAYS) },
    secret,
  );
  return `${clientEnv.NEXT_PUBLIC_SITE_URL}${TRAINING_BASE}/book/manage?t=${token}`;
}

/**
 * The purge, in its own transaction and its own failure. The holds, calendar
 * and confirmations before it have already committed; one bad row here must
 * not turn every run red and hide a real failure among them. It is reported
 * in the answer and logged at error level until it is fixed.
 */
async function purgeOrReport(now: Date): Promise<PurgeReport | { error: string }> {
  try {
    return await withTransaction((runner) => purgeExpiredPersonalData(runner, now));
  } catch (error) {
    logger.error("personal data purge failed", { error: (error as Error).message });
    return { error: "purge failed" };
  }
}
