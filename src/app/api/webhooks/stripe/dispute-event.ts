import { NextResponse } from "next/server";
import { lockPayment } from "@/data/payment-lock";
import { withTransaction } from "@/data/db";
import { applyDisputeEffects, recordDispute } from "@/data/disputes";
import { claimWebhookEvent, markWebhookProcessed } from "@/data/webhook-events";
import {
  DisputeReadError,
  type DisputeEvent,
  type PaymentProvider,
} from "@/domain/payments/provider";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * A verified dispute event (rules: domain/payments/dispute-policy.ts).
 *
 * The dispute is read again from the processor BEFORE the transaction, and
 * that answer is what is stored: events are not delivered in order, and two
 * of them can carry the same second, so acting on the event's own copy could
 * move a dispute backwards. The read is outside the transaction so no row is
 * locked while the processor is asked. If it cannot be asked, the delivery
 * fails and the processor sends it again, which is the retry we want.
 *
 * Then, as for every event: claim the id, store, act, in one transaction.
 */
export async function handleDisputeEvent(
  event: DisputeEvent,
  payments: PaymentProvider,
): Promise<NextResponse> {
  let dispute;
  try {
    dispute = await payments.getDispute(event.providerDisputeId);
  } catch (error) {
    /*
      A clear refusal will not change on a retry, and failing the delivery for
      three days would store nothing and tell nobody. The event's own copy is
      stored instead: older, perhaps, but a later event or the desk puts it
      right. Anything else may work next time, so the processor sends it again.
    */
    if (error instanceof DisputeReadError && !error.transient) {
      logger.error("a dispute could not be read; stored as the event carried it", {
        eventId: event.eventId,
        code: error.code,
      });
      dispute = event.snapshot;
    } else {
      logger.error("a dispute could not be read from the processor; the delivery will be retried", {
        eventId: event.eventId,
        code: error instanceof DisputeReadError ? error.code : (error as Error).name,
      });
      return NextResponse.json({ error: "Could not read the dispute" }, { status: 500 });
    }
  }

  try {
    const outcome = await withTransaction(async (runner) => {
      const claim = await claimWebhookEvent(runner, event.eventId, event.type);
      if (!claim.isFirstDelivery) return "duplicate" as const;
      // Before anything reads the order by its payment: settlement may be writing it now.
      await lockPayment(runner, dispute.paymentIntentId);
      const now = new Date();
      const recorded = await recordDispute(runner, dispute, now);
      const cancelled =
        recorded.orderId === null ? [] : await applyDisputeEffects(runner, recorded.orderId, now);
      await markWebhookProcessed(runner, event.eventId);
      return { recorded, cancelled };
    });

    if (outcome === "duplicate") {
      logger.info("a duplicate dispute delivery was ignored", { eventId: event.eventId });
      return NextResponse.json({ ok: true, outcome: "duplicate" });
    }

    const { recorded, cancelled } = outcome;
    await recordAudit({
      action: "order.disputed",
      actor: { kind: "provider", provider: "stripe" },
      subject: recorded.orderId === null ? `dispute:${recorded.id}` : `order:${recorded.orderId}`,
      metadata: {
        eventId: event.eventId,
        disputeId: recorded.id,
        status: recorded.status,
        applied: recorded.applied,
        cancelledBookings: cancelled.length,
      },
    });
    // Error level: every dispute is money a bank is taking back, and the desk alert follows within five minutes.
    logger.error("A PAYMENT IS DISPUTED - respond in the payment dashboard before the deadline", {
      disputeId: recorded.id,
      orderId: recorded.orderId,
      status: recorded.status,
      cancelledBookings: cancelled.length,
    });
    return NextResponse.json({ ok: true, outcome: recorded.applied ? "recorded" : "stale" });
  } catch (error) {
    // The claim rolled back with everything else, so the retry starts cleanly.
    logger.error("a stripe dispute event could not be recorded", {
      eventId: event.eventId,
      error: (error as Error).name,
    });
    return NextResponse.json({ error: "Could not record" }, { status: 500 });
  }
}
