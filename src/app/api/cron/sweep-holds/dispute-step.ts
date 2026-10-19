import { renderDisputeNeedsResponse } from "@/components/emails/dispute-alert";
import type { PaidButUnscheduled } from "@/data/audit-events";
import type { QueryRunner } from "@/data/db";
import { reconcileDeskAlerts, type DeskAlertReport } from "@/data/desk-alerts";
import {
  applyDisputeEffects,
  linkUnlinkedDisputes,
  listDisputesForDesk,
  ordersWithDisputeWork,
} from "@/data/disputes";
import type { EmailProvider } from "@/domain/messaging/provider";
import { CHOOSE_TIME_LINK_DAYS } from "@/components/emails/desk-alerts";
import { logger } from "@/lib/logger";

/**
 * The sweep's part in disputes and in paid bookings with no time.
 *
 * Disputes: a dispute that arrived before its order's own payment is linked
 * once the order has the payment, and every order whose disputes still have
 * work (a stolen-card or lost dispute with a session still open) has its
 * effects applied again. Applying them is idempotent, so this is the webhook's
 * safety net, not a second decision. Then the desk alert, per dispute.
 *
 * Paid with no time: the customer's own choose-a-time email is queued, once
 * per booking (founder decision, October 2026).
 *
 * Each in its own failure domain: one broken row must not stop the rest of
 * the sweep.
 */

export type TransactionRunner = <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;

export interface DisputeStepDeps {
  readonly transaction: TransactionRunner;
  readonly email: () => EmailProvider;
  readonly clock: () => Date;
  readonly desk: () => string;
}

export interface DisputeStepReport {
  readonly linked: number;
  readonly cancelledBookings: number;
  readonly failed: number;
  readonly deskAlerts: DeskAlertReport | { readonly error: string };
}

export async function disputeStep(deps: DisputeStepDeps): Promise<DisputeStepReport> {
  let linked: readonly string[] = [];
  let work: readonly string[] = [];
  let failed = 0;
  try {
    linked = await deps.transaction((runner) => linkUnlinkedDisputes(runner, deps.clock()));
    work = await deps.transaction((runner) => ordersWithDisputeWork(runner, deps.clock()));
  } catch (error) {
    failed += 1;
    logger.error("disputes could not be read this run; they will be tried again next run", {
      error: (error as Error).name,
    });
  }

  let cancelledBookings = 0;
  for (const orderId of new Set([...linked, ...work])) {
    try {
      const cancelled = await deps.transaction((runner) =>
        applyDisputeEffects(runner, orderId, deps.clock()),
      );
      cancelledBookings += cancelled.length;
    } catch (error) {
      failed += 1;
      logger.error("a dispute's effects could not be applied; tried again next run", {
        orderId,
        error: (error as Error).name,
      });
    }
  }

  let deskAlerts: DeskAlertReport | { readonly error: string };
  try {
    const disputes = await deps.transaction((runner) => listDisputesForDesk(runner, deps.clock()));
    deskAlerts = await reconcileDeskAlerts(
      "dispute_needs_response",
      disputes.map((dispute) => ({
        // An outcome is its own alert: it must not wait behind a reminder of the dispute itself.
        subjectKey:
          dispute.kind === "outcome" ? `dispute-outcome:${dispute.id}` : `dispute:${dispute.id}`,
        render: (reminder) => renderDisputeNeedsResponse(dispute, reminder, deps.clock()),
      })),
      { email: deps.email, transaction: deps.transaction, clock: deps.clock },
      deps.desk(),
    );
  } catch (error) {
    logger.error("dispute desk alerts could not be sent; they will be tried again next run", {
      error: (error as Error).name,
    });
    deskAlerts = { error: "desk alerts could not be sent" };
  }

  return { linked: linked.length, cancelledBookings, failed, deskAlerts };
}

/** A link not used within its life is sent again, fresh, while the booking still waits. */
const RESEND_AFTER_MS = CHOOSE_TIME_LINK_DAYS * 24 * 60 * 60_000;

/**
 * Queue the choose-a-time email for each paid booking with no time that can
 * be given one from a link: a booking exists, the order is exactly paid, and
 * it has never been disputed.
 *
 * The queue keeps one row per booking and email, so the row is put back in
 * the queue, rather than a second one made, when the booking lost its time
 * again after the last try (it chose a time, then the calendar refused it),
 * or when the link sent has run out. Returns how many were queued this run.
 * One booking that fails is counted and the rest still go.
 */
export async function queueChooseNewTime(
  waiting: readonly PaidButUnscheduled[],
  deps: Pick<DisputeStepDeps, "transaction" | "clock">,
  linkSecretSet: boolean,
): Promise<{ readonly queued: number; readonly failed: number }> {
  // Without the secret no link can be made; the desk alert says so and offers a refund instead.
  if (!linkSecretSet) return { queued: 0, failed: 0 };
  let queued = 0;
  let failed = 0;
  for (const problem of waiting) {
    if (problem.bookingId === null || !problem.fullyPaid || problem.disputed) continue;
    const { bookingId, waitingSince } = problem;
    try {
      const now = deps.clock();
      const result = await deps.transaction((runner) =>
        runner.query<{ id: string }>(
          `insert into communication_log (booking_id, channel, template_key, status, scheduled_for)
           values ($1, 'email', 'choose_new_time', 'queued', $2)
           on conflict (booking_id, template_key) do update
              set status = 'queued', scheduled_for = excluded.scheduled_for, attempts = 0,
                  sent_at = null, failed_at = null, last_error = null, error_code = null,
                  provider_message_id = null
            where communication_log.status <> 'queued'
              and (coalesce(communication_log.sent_at, communication_log.last_attempt_at,
                            communication_log.created_at) < $3
                   or communication_log.sent_at < $4)
           returning id`,
          [bookingId, now, waitingSince ?? now, new Date(now.getTime() - RESEND_AFTER_MS)],
        ),
      );
      queued += result.rows.length;
    } catch (error) {
      failed += 1;
      logger.error("a choose-a-time email could not be queued; tried again next run", {
        bookingId,
        error: (error as Error).name,
      });
    }
  }
  return { queued, failed };
}
