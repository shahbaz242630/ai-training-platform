import type { QueryRunner } from "./db";
import {
  applyRefundEvent,
  claimDueRefunds,
  closeRefund,
  keyWindowPassed,
  recordRefundIssued,
  recordRefundRetry,
  refundIdempotencyKey,
  type ClaimedRefund,
  type OrderRefundMove,
  type RefundEventOutcome,
} from "./refunds";
import { listPendingRefundsToRefresh, markRefundChecked } from "./refund-queries";
import {
  RefundRefusedError,
  RefundUnclearError,
  type PaymentProvider,
} from "@/domain/payments/provider";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * The sweep's refund step: ask the processor for every refund owed, and read
 * again the ones it has gone quiet about.
 *
 * The same shape as sending email: claim in one short transaction, talk to
 * the processor with no transaction open, record the answer in another. A
 * database connection is never held while waiting on the network, and the
 * claim alone keeps two runs from asking for the same refund.
 */

export type TransactionRunner = <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;

export interface RefundStepDeps {
  readonly provider: PaymentProvider;
  readonly transaction: TransactionRunner;
  /**
   * Read fresh at every claim and every record, never once for the run: a
   * lease or a wait measured from when the sweep started would already be
   * partly spent by the time a later refund is reached.
   */
  readonly clock: () => Date;
}

export interface IssueReport {
  readonly claimed: number;
  readonly issued: number;
  readonly retrying: number;
  readonly failed: number;
  readonly superseded: number;
  /** A processor event recorded the outcome while this run was asking. */
  readonly alreadySettled: number;
}

/** Five per run: the volume is small, and a run must finish well inside five minutes. */
const BATCH = 5;

/**
 * One refund at a time: claim it, ask, record, then the next. A claim taken
 * for a batch would sit waiting behind the requests before it, its lease
 * running down while nothing was being sent.
 */
export async function issueDueRefunds(deps: RefundStepDeps): Promise<IssueReport> {
  const report = {
    claimed: 0,
    issued: 0,
    retrying: 0,
    failed: 0,
    superseded: 0,
    alreadySettled: 0,
  };
  for (let i = 0; i < BATCH; i += 1) {
    const [refund] = await deps.transaction((runner) => claimDueRefunds(runner, deps.clock(), 1));
    if (!refund) break;
    report.claimed += 1;
    report[await issueOne(refund, deps)] += 1;
  }
  return report;
}

type IssueOutcome = "issued" | "retrying" | "failed" | "superseded" | "alreadySettled";

async function issueOne(refund: ClaimedRefund, deps: RefundStepDeps): Promise<IssueOutcome> {
  const { transaction, clock } = deps;

  /*
    Checked before anything is sent. An order already refunded, in the
    dashboard most likely, owes nothing more. One partly refunded needs a
    person to work out what is left, so it is not guessed at. And a key older
    than Stripe keeps its answer is never sent again: if the first request did
    go through, a repeat after the window would refund twice.
  */
  if (refund.orderPaymentStatus === "refunded") {
    const closed = await transaction((runner) =>
      closeRefund(runner, refund.id, "superseded", null, clock()),
    );
    if (!closed) return "alreadySettled";
    logger.info("a refund owed was already made another way; nothing sent", {
      refundId: refund.id,
    });
    return "superseded";
  }
  const failWith = (code: string) => fail(refund, code, deps);
  if (refund.orderPaymentStatus === "partially_refunded") {
    return failWith("order_partially_refunded");
  }
  if (refund.orderPaymentStatus !== "paid") return failWith("order_not_paid");
  if (refund.paymentIntentId === null) return failWith("no_payment_intent");
  if (keyWindowPassed(refund, clock())) return failWith("key_window_passed");

  let issued;
  try {
    issued = await deps.provider.refundPayment({
      paymentIntentId: refund.paymentIntentId,
      amountFils: refund.amountFils,
      idempotencyKey: refundIdempotencyKey(refund),
      metadata: { orderId: refund.orderId, refundId: refund.id },
    });
  } catch (error) {
    if (error instanceof RefundRefusedError && error.alreadyRefunded) {
      return failWith(error.code);
    }
    /*
      Anything not clearly refused is unclear: it may have gone through, so
      the next attempt uses the same key and the processor answers with the
      refund it already made.
    */
    const refused = error instanceof RefundRefusedError;
    const code = refused || error instanceof RefundUnclearError ? error.code : "unknown";
    const next = await transaction((runner) =>
      recordRefundRetry(runner, refund, { code, newKey: refused }, clock()),
    );
    if (next === "already_settled") return "alreadySettled";
    if (next === "gave_up") {
      await alarm(refund, code);
      return "failed";
    }
    logger.warn("a refund request did not go through; it will be tried again", {
      refundId: refund.id,
      attempt: refund.attempts,
      code,
    });
    return "retrying";
  }

  const move = await transaction((runner) => recordRefundIssued(runner, refund, issued, clock()));
  await recordAudit({
    action: "order.refund_requested",
    actor: { kind: "system", process: "sweep-refunds" },
    subject: `order:${refund.orderId}`,
    metadata: {
      refundId: refund.id,
      providerRefundId: issued.providerRefundId,
      amountFils: refund.amountFils,
      status: issued.status,
    },
  });
  await auditOrderMove(refund.orderId, move, { refundId: refund.id });
  logger.info("a withdrawal refund was issued", { refundId: refund.id, status: issued.status });
  return "issued";
}

/** Fail the claim for a person. No alarm when an event already recorded the real outcome. */
async function fail(
  refund: ClaimedRefund,
  code: string,
  deps: RefundStepDeps,
): Promise<"failed" | "alreadySettled"> {
  const closed = await deps.transaction((runner) =>
    closeRefund(runner, refund.id, "failed", code, deps.clock()),
  );
  if (!closed) return "alreadySettled";
  await alarm(refund, code);
  return "failed";
}

async function alarm(refund: ClaimedRefund, code: string): Promise<void> {
  await recordAudit({
    action: "order.refund_failed",
    actor: { kind: "system", process: "sweep-refunds" },
    subject: `order:${refund.orderId}`,
    metadata: { refundId: refund.id, code },
  });
  logger.error("REFUND FAILED - refund this order by hand in the Stripe dashboard", {
    refundId: refund.id,
    orderId: refund.orderId,
    code,
  });
}

/** An audit line when the order's payment status actually moved, and only then. */
export async function auditOrderMove(
  orderId: string,
  move: OrderRefundMove,
  metadata: Record<string, unknown>,
): Promise<void> {
  if (move !== "refunded" && move !== "partially_refunded") return;
  await recordAudit({
    action: "order.refunded",
    actor: { kind: "provider", provider: "stripe" },
    subject: `order:${orderId}`,
    metadata: { ...metadata, paymentStatus: move },
  });
}

/**
 * Report what a refund event did. Shared by the webhook and the refresh, so
 * both leave the same trail. A refund turning failed or cancelled calls a
 * person; one that names a payment we do not know, or disagrees with the
 * order, is kept as evidence.
 */
export async function reportRefundEvent(
  outcome: RefundEventOutcome,
  eventId: string,
): Promise<void> {
  const subject = `order:${outcome.orderId ?? "unknown"}`;
  switch (outcome.result) {
    case "stale":
      logger.info("an older refund event arrived after a newer one; nothing changed", { eventId });
      return;
    case "unknown_order":
    case "mismatched":
      await recordAudit({
        action: "admin.action",
        actor: { kind: "provider", provider: "stripe" },
        subject,
        metadata: { eventId, reason: `refund event ${outcome.result}` },
      });
      logger.error("a refund event did not match an order of ours; nothing changed", {
        eventId,
        result: outcome.result,
      });
      return;
    case "applied":
      if (outcome.status === "failed" || outcome.status === "canceled") {
        await recordAudit({
          action: "order.refund_failed",
          actor: { kind: "provider", provider: "stripe" },
          subject,
          metadata: { eventId, refundId: outcome.refundId, status: outcome.status },
        });
        logger.error("REFUND FAILED AFTER IT WAS MADE - refund this order by hand", {
          eventId,
          orderId: outcome.orderId,
        });
      }
      if (outcome.orderMove === "refused") {
        logger.error("a refund arrived for an order whose payment status cannot take it", {
          eventId,
          orderId: outcome.orderId,
        });
      }
      if (outcome.orderId !== null) {
        await auditOrderMove(outcome.orderId, outcome.orderMove, {
          eventId,
          refundId: outcome.refundId,
        });
      }
      return;
  }
}

export interface RefreshReport {
  readonly checked: number;
  readonly changed: number;
  readonly failed: number;
}

/**
 * Read again every refund the processor has said nothing more about for an
 * hour, and apply what it says now. This is what keeps refunds moving if the
 * refund events were never switched on, or one was lost.
 */
export async function refreshPendingRefunds(deps: RefundStepDeps): Promise<RefreshReport> {
  const quiet = await deps.transaction((runner) =>
    listPendingRefundsToRefresh(runner, deps.clock(), BATCH * 2),
  );
  const report = { checked: quiet.length, changed: 0, failed: 0 };

  for (const refund of quiet) {
    // Noted first, so a refund that cannot be read is asked about again in an hour, not every run.
    await deps.transaction((runner) => markRefundChecked(runner, refund.id, deps.clock()));
    try {
      const snapshot = await deps.provider.getRefund(refund.providerRefundId);
      const now = deps.clock();
      const eventId = `refresh:${refund.id}:${now.toISOString()}`;
      const outcome = await deps.transaction((runner) =>
        applyRefundEvent(
          runner,
          {
            kind: "refund",
            eventId,
            type: "refund.refreshed",
            occurredAt: now,
            ignorable: false,
            orderId: null,
            refundRowId: refund.id,
            providerRefundId: snapshot.providerRefundId,
            paymentIntentId: snapshot.paymentIntentId,
            amountFils: snapshot.amountFils,
            currency: snapshot.currency,
            status: snapshot.status,
          },
          now,
        ),
      );
      if (outcome.result === "applied" && outcome.status !== "pending") report.changed += 1;
      await reportRefundEvent(outcome, eventId);
    } catch (error) {
      report.failed += 1;
      logger.error("a pending refund could not be read again; will retry", {
        refundId: refund.id,
        error: (error as Error).name,
      });
    }
  }
  return report;
}
