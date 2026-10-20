import { NextResponse } from "next/server";
import { lockPayment } from "@/data/payment-lock";
import { withTransaction } from "@/data/db";
import { recordFraudWarning } from "@/data/fraud-warnings";
import { claimWebhookEvent, markWebhookProcessed } from "@/data/webhook-events";
import type { FraudWarningEvent } from "@/domain/payments/provider";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * A verified early fraud warning (rules: data/fraud-warnings.ts).
 *
 * The same order of operations as every event: claim the id, then store and
 * act, in one transaction, so a redelivery is a no-op. The refund itself is
 * sent by the sweep within five minutes, with its own retries; nothing here
 * waits on the processor. Every outcome but a database failure answers 2xx:
 * a warning about a payment we do not know cannot become ours by being
 * retried. The desk hears about every one (sweep, fraud-warning-step).
 */
export async function handleFraudWarningEvent(event: FraudWarningEvent): Promise<NextResponse> {
  try {
    const outcome = await withTransaction(async (runner) => {
      const claim = await claimWebhookEvent(runner, event.eventId, event.type);
      if (!claim.isFirstDelivery) return "duplicate" as const;
      // Before anything reads the order by its payment: settlement may be writing it now.
      await lockPayment(runner, event.paymentIntentId);
      const recorded = await recordFraudWarning(runner, event, new Date());
      await markWebhookProcessed(runner, event.eventId);
      return recorded;
    });

    if (outcome === "duplicate" || !outcome.isNew) {
      logger.info("a duplicate fraud warning delivery was ignored", { eventId: event.eventId });
      return NextResponse.json({ ok: true, outcome: "duplicate" });
    }

    await recordAudit({
      action: "order.fraud_warning",
      actor: { kind: "provider", provider: "stripe" },
      subject:
        outcome.orderId === null ? `fraud_warning:${outcome.id}` : `order:${outcome.orderId}`,
      metadata: {
        eventId: event.eventId,
        fraudWarningId: outcome.id,
        outcome: outcome.outcome,
        cancelledBookings: outcome.cancelledBookings.length,
      },
    });
    // Error level: a stolen card is behind this payment, and the desk alert follows within five minutes.
    logger.error("AN EARLY FRAUD WARNING ARRIVED - the desk is being told", {
      fraudWarningId: outcome.id,
      orderId: outcome.orderId,
      outcome: outcome.outcome,
      cancelledBookings: outcome.cancelledBookings.length,
    });
    return NextResponse.json({ ok: true, outcome: outcome.outcome });
  } catch (error) {
    // The claim rolled back with everything else, so the retry starts cleanly.
    logger.error("a stripe fraud warning could not be recorded", {
      eventId: event.eventId,
      error: (error as Error).name,
    });
    return NextResponse.json({ error: "Could not record" }, { status: 500 });
  }
}
