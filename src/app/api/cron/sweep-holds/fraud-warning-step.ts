import { renderFraudWarning } from "@/components/emails/fraud-warning-alert";
import type { QueryRunner } from "@/data/db";
import { reconcileDeskAlerts, type DeskAlertReport } from "@/data/desk-alerts";
import { listFraudWarningsForDesk } from "@/data/fraud-warnings";
import type { EmailProvider } from "@/domain/messaging/provider";
import { logger } from "@/lib/logger";

/**
 * The sweep's step for early fraud warnings (audit s104 PAY-4): an email to
 * the desk for each one, again each day while one waits for a person, closed
 * quietly once it is refunded or old. The refund itself, when one was queued,
 * is sent by the refund step like any other.
 *
 * In its own failure, like every desk alert.
 */

export interface FraudWarningStepDeps {
  readonly transaction: <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;
  /** Asked for only when there is something to send. */
  readonly email: () => EmailProvider;
  readonly clock: () => Date;
  readonly desk: () => string;
}

export async function fraudWarningAlerts(
  deps: FraudWarningStepDeps,
): Promise<(DeskAlertReport & { readonly open: number }) | { error: string }> {
  try {
    const warnings = await deps.transaction((runner) =>
      listFraudWarningsForDesk(runner, deps.clock()),
    );
    const report = await reconcileDeskAlerts(
      "fraud_warning",
      warnings.map((warning) => ({
        subjectKey: `fraud-warning:${warning.id}`,
        render: (reminder) => renderFraudWarning(warning, reminder),
      })),
      { email: deps.email, transaction: deps.transaction, clock: deps.clock },
      deps.desk(),
    );
    return { ...report, open: warnings.length };
  } catch (error) {
    logger.error("fraud warning desk alerts could not be sent; they will be tried again next run", {
      error: (error as Error).name,
    });
    return { error: "desk alerts could not be sent" };
  }
}
