import type { QueryRunner } from "@/data/db";
import { abandonedCheckoutSessions } from "@/data/orders";
import type { PaymentProvider } from "@/domain/payments/provider";
import { logger } from "@/lib/logger";

/**
 * Ending the checkouts a customer gave up by starting another (audit s101
 * P10). Checkout asks Stripe once when it happens; if that fails, the first
 * tab could still be paid, and the customer would pay twice. This asks again
 * every run while the checkout can live. Once Stripe ends it, its expired
 * event fails the order the ordinary way and it drops out of the list.
 *
 * Its own failure domain: a processor outage must not turn the sweep red.
 */

export type TransactionRunner = <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;

export interface AbandonedCheckoutDeps {
  readonly provider: () => PaymentProvider;
  readonly transaction: TransactionRunner;
  readonly clock: () => Date;
}

export interface AbandonedCheckoutReport {
  readonly ended: number;
  readonly failed: number;
}

export async function endAbandonedCheckouts(
  deps: AbandonedCheckoutDeps,
): Promise<AbandonedCheckoutReport | { readonly error: string }> {
  let sessions: readonly string[];
  try {
    sessions = await deps.transaction((runner) => abandonedCheckoutSessions(runner, deps.clock()));
  } catch (error) {
    logger.error("abandoned checkouts could not be listed; tried again next run", {
      error: (error as Error).name,
    });
    return { error: "could not list" };
  }
  if (sessions.length === 0) return { ended: 0, failed: 0 };

  let provider: PaymentProvider;
  try {
    provider = deps.provider();
  } catch {
    // Payments not configured: nothing can have been paid either.
    return { ended: 0, failed: 0 };
  }

  let ended = 0;
  let failed = 0;
  for (const session of sessions) {
    try {
      await provider.expireCheckout(session);
      ended += 1;
    } catch (error) {
      failed += 1;
      logger.warn("an abandoned checkout could not be ended; tried again next run", {
        error: (error as Error).name,
      });
    }
  }
  if (ended > 0) logger.info("abandoned checkouts ended", { ended });
  return { ended, failed };
}
