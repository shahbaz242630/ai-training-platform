import { renderWithdrawalDecision } from "@/components/emails/withdrawal-decision-alert";
import type { QueryRunner } from "@/data/db";
import { reconcileDeskAlerts, type DeskAlertReport } from "@/data/desk-alerts";
import { listWithdrawalsForDesk } from "@/data/withdrawals";
import type { EmailProvider } from "@/domain/messaging/provider";
import { BOOKING_POLICY, TRAINING_BASE } from "@/config/site";
import { createDeclineToken } from "@/lib/desk-link";
import { clientEnv, serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { addDays } from "@/lib/time";

/**
 * The sweep's step for withdrawals the desk decides: an email to the booking
 * desk for each one, again each day while it waits, closed quietly once it is
 * refunded, its session begins, or the refund days are over.
 *
 * In its own failure, like every desk alert: email being down must not turn
 * the sweep red, and nothing is recorded as sent unless it went.
 */

export interface WithdrawalDecisionDeps {
  readonly transaction: <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;
  /** Asked for only when there is something to send. */
  readonly email: () => EmailProvider;
  readonly clock: () => Date;
  /** The booking desk's address; read inside the step, so a configuration error is its own. */
  readonly desk: () => string;
  /** The desk's signed link to decline one notice, made fresh for every send; null without a secret. */
  readonly declineUrl: (bookingId: string) => string | null;
}

export async function withdrawalDecisionAlerts(
  deps: WithdrawalDecisionDeps,
): Promise<(DeskAlertReport & { readonly waiting: number }) | { error: string }> {
  try {
    const waiting = await deps.transaction((runner) =>
      listWithdrawalsForDesk(runner, deps.clock()),
    );
    const report = await reconcileDeskAlerts(
      "withdrawal_needs_decision",
      waiting.map((alert) => ({
        subjectKey: `withdrawal:${alert.bookingId}`,
        render: (reminder) =>
          renderWithdrawalDecision(alert, reminder, deps.declineUrl(alert.bookingId)),
      })),
      { email: deps.email, transaction: deps.transaction, clock: deps.clock },
      deps.desk(),
    );
    return { ...report, waiting: waiting.length };
  } catch (error) {
    logger.error("withdrawal desk alerts could not be sent; they will be tried again next run", {
      error: (error as Error).name,
      code: (error as { code?: unknown }).code ?? null,
    });
    return { error: "desk alerts could not be sent" };
  }
}

/**
 * The desk's link to decline a withdrawal, valid while the decision matters:
 * the refund days and a day's grace, counted from now so every reminder's
 * link outlives the alert. Null when no signing secret is set.
 */
export function declineUrlFor(bookingId: string): string | null {
  const secret = serverEnv().MANAGE_LINK_SECRET;
  if (!secret) return null;
  const token = createDeclineToken(
    { bookingId, expiresAt: addDays(new Date(), BOOKING_POLICY.withdrawalRefundDays + 1) },
    secret,
  );
  return `${clientEnv.NEXT_PUBLIC_SITE_URL}${TRAINING_BASE}/book/desk-decision?t=${token}`;
}
