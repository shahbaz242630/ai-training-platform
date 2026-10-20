import { NextResponse } from "next/server";
import { lockPayment } from "@/data/payment-lock";
import { withTransaction } from "@/data/db";
import { holdRefundEvent } from "@/data/held-refunds";
import { applyRefundEvent } from "@/data/refunds";
import { reportRefundEvent } from "@/data/refund-issuer";
import { claimWebhookEvent, markWebhookProcessed } from "@/data/webhook-events";
import type { RefundEvent } from "@/domain/payments/provider";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * A verified refund event: ours, or one made in the processor's dashboard.
 *
 * The same order of operations as a payment: claim the event id, then act, in
 * one transaction, so a redelivery is a no-op. It runs before the payment
 * path's "no order id" guard on purpose. A refund made in the dashboard
 * carries none of our metadata, and the order is found from its payment
 * inside the transaction instead.
 *
 * Every outcome but a database failure answers 2xx: a refund that names a
 * payment we do not know, or disagrees with its order, cannot become valid by
 * being retried. It is kept as evidence and a person is told.
 */
export async function handleRefundEvent(event: RefundEvent): Promise<NextResponse> {
  try {
    const outcome = await withTransaction(async (runner) => {
      const claim = await claimWebhookEvent(runner, event.eventId, event.type);
      if (!claim.isFirstDelivery) return "duplicate" as const;
      // Before anything reads the order by its payment: settlement may be writing it now.
      await lockPayment(runner, event.paymentIntentId);
      const now = new Date();
      const applied = await applyRefundEvent(runner, event, now);
      /*
        A dashboard refund (no metadata of ours) for a payment no order has
        yet: held, and applied when the payment settles (audit s104 PAY-2).
      */
      if (applied.result === "unknown_order" && event.orderId === null) {
        await holdRefundEvent(runner, event, now);
      }
      await markWebhookProcessed(runner, event.eventId);
      return applied;
    });

    if (outcome === "duplicate") {
      await recordAudit({
        action: "webhook.duplicate_ignored",
        actor: { kind: "provider", provider: "stripe" },
        subject: `refund:${event.providerRefundId}`,
        metadata: { eventId: event.eventId },
      });
      logger.info("a duplicate refund delivery was ignored", { eventId: event.eventId });
      return NextResponse.json({ ok: true, outcome: "duplicate" });
    }

    await reportRefundEvent(outcome, event.eventId);
    return NextResponse.json({ ok: true, outcome: outcome.result });
  } catch (error) {
    /*
      The claim rolled back with everything else, so the processor's retry
      starts cleanly. The error's name only: its message can carry query
      values, and they do not belong in a log.
    */
    logger.error("a stripe refund event could not be recorded", {
      eventId: event.eventId,
      error: (error as Error).name,
    });
    return NextResponse.json({ error: "Could not record" }, { status: 500 });
  }
}
