import {
  renderPaymentEventsMissing,
  renderReconciliationFailing,
} from "@/components/emails/payment-events-alert";
import type { QueryRunner } from "@/data/db";
import { reconcileDeskAlerts, type DeskAlertReport } from "@/data/desk-alerts";
import {
  countFailingReconciliation,
  countRecentlyReconciled,
  listOrdersToReconcile,
  markChecked,
  markReconciled,
} from "@/data/reconciliation";
import type { EmailProvider } from "@/domain/messaging/provider";
import type { PaymentProvider } from "@/domain/payments/provider";
import { logger } from "@/lib/logger";
import {
  applyCheckoutOutcome,
  confirmOnCalendar,
  reportOutcome,
  type CheckoutOutcome,
} from "../../webhooks/stripe/checkout-outcome";

/**
 * The sweep's safety net for payment events that never arrived. For each
 * order still pending well after its checkout ended, ask the processor how
 * the checkout ended and apply that through the webhook's own path: a paid
 * customer is booked and emailed, an abandoned checkout releases its time.
 * Anything settled this way means the events are missing, so the desk is told
 * until a day passes without one.
 *
 * In its own failure, like every sweep step: one order the processor cannot
 * answer about is logged and asked about again next run.
 */

export interface ReconcileDeps {
  readonly provider: () => PaymentProvider;
  readonly transaction: <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;
  readonly clock: () => Date;
  readonly email: () => EmailProvider;
  readonly desk: () => string;
  /** Promote a settled order's booking on the calendar; the sweep retries it anyway. */
  readonly confirm?: (orderId: string) => Promise<void>;
}

export interface ReconcileReport {
  readonly asked: number;
  readonly settled: number;
  readonly released: number;
  readonly waiting: number;
  readonly failed: number;
  readonly deskAlert: DeskAlertReport | { error: string } | null;
}

/** Five a run: rescues are rare, and each one asks the processor once. */
const BATCH = 5;

const RESCUED: ReadonlySet<CheckoutOutcome> = new Set(["settled", "paid_without_slot", "released"]);

export async function reconcilePendingOrders(
  deps: ReconcileDeps,
): Promise<ReconcileReport | { error: string }> {
  try {
    const due = await deps.transaction((runner) =>
      listOrdersToReconcile(runner, deps.clock(), BATCH),
    );
    const report = { asked: due.length, settled: 0, released: 0, waiting: 0, failed: 0 };
    if (due.length > 0) {
      const provider = deps.provider();
      for (const order of due) {
        try {
          const snapshot = await provider.getCheckoutSnapshot(order.checkoutSessionId);
          if (snapshot.outcome === "unpaid") {
            report.waiting += 1;
            await deps.transaction((runner) =>
              markChecked(runner, order.orderId, deps.clock(), null),
            );
            continue;
          }
          const now = deps.clock();
          // The order we asked about, never one the session names: its id is ours to trust.
          const outcome = await deps.transaction(async (runner) => {
            const applied = await applyCheckoutOutcome(
              runner,
              { ...snapshot, orderId: order.orderId },
              now,
            );
            if (RESCUED.has(applied)) await markReconciled(runner, order.orderId, now);
            // A session that will not settle this order is the safety net failing, and is counted as such.
            const refused = applied === "mismatched" || applied === "refused";
            await markChecked(runner, order.orderId, now, refused ? applied : null);
            return applied;
          });
          const eventId = `reconcile:${order.orderId}`;
          await reportOutcome(outcome, eventId, order.orderId, "reconciliation");
          if (outcome === "settled" || outcome === "paid_without_slot") {
            report.settled += 1;
            logger.error("a payment was settled by asking Stripe: its notice never arrived", {
              orderId: order.orderId,
              outcome,
            });
          }
          if (outcome === "released") report.released += 1;
          if (outcome === "settled") await (deps.confirm ?? confirmOnCalendar)(order.orderId);
        } catch (error) {
          report.failed += 1;
          await deps.transaction((runner) =>
            markChecked(runner, order.orderId, deps.clock(), (error as Error).name),
          );
          logger.error("a pending order could not be checked with Stripe; will retry", {
            orderId: order.orderId,
            error: (error as Error).name,
          });
        }
      }
    }
    return { ...report, deskAlert: await alertDesk(deps) };
  } catch (error) {
    logger.error("the reconciliation step failed; it will run again next time", {
      error: (error as Error).name,
    });
    return { error: "reconciliation failed" };
  }
}

async function alertDesk(deps: ReconcileDeps): Promise<DeskAlertReport | { error: string }> {
  try {
    const [rescued, failing] = await deps.transaction((runner) =>
      Promise.all([
        countRecentlyReconciled(runner, deps.clock()),
        countFailingReconciliation(runner, deps.clock()),
      ]),
    );
    const problems = [];
    if (rescued > 0) {
      problems.push({
        subjectKey: "stripe:checkout-events",
        render: (reminder: boolean) => renderPaymentEventsMissing(rescued, reminder),
      });
    }
    if (failing > 0) {
      problems.push({
        subjectKey: "stripe:reconciliation-failing",
        render: (reminder: boolean) => renderReconciliationFailing(failing, reminder),
      });
    }
    return await reconcileDeskAlerts(
      "payment_events_missing",
      problems,
      { email: deps.email, transaction: deps.transaction, clock: deps.clock },
      deps.desk(),
    );
  } catch (error) {
    logger.error("the missing-events desk alert could not be sent; it will be tried again", {
      error: (error as Error).name,
    });
    return { error: "desk alert could not be sent" };
  }
}
