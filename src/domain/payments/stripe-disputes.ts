import Stripe from "stripe";
import { DisputeReadError, type DisputeEvent, type DisputeSnapshot } from "./provider";

/**
 * The dispute half of the Stripe adapter: reading dispute events and
 * disputes. Like stripe-refunds.ts, the only place that knows these shapes
 * are Stripe's.
 *
 * The other `charge.dispute.*` events (funds withdrawn, funds reinstated)
 * follow the money, not the dispute's state, and are ignored: the three below
 * already arrive for every change of status.
 */

export const DISPUTE_EVENTS = new Set([
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
]);

/** Only the id is read from the event; the handler reads the dispute itself. */
export function toDisputeEvent(event: Stripe.Event): DisputeEvent {
  const dispute = event.data.object as Stripe.Dispute;
  return {
    kind: "dispute",
    eventId: event.id,
    type: event.type,
    occurredAt: new Date(event.created * 1000),
    ignorable: false,
    providerDisputeId: dispute.id,
    snapshot: toDisputeSnapshot(dispute),
  };
}

/** Sort a failed read: worth asking again, or a clear refusal. Only the code is kept. */
export function classifyDisputeReadError(error: unknown): DisputeReadError {
  if (!(error instanceof Stripe.errors.StripeError)) return new DisputeReadError("unknown", true);
  if (
    error instanceof Stripe.errors.StripeConnectionError ||
    error instanceof Stripe.errors.StripeAPIError ||
    error instanceof Stripe.errors.StripeRateLimitError
  ) {
    return new DisputeReadError(error.code ?? error.type, true);
  }
  const status = error.statusCode ?? 0;
  if (status >= 400 && status < 500 && status !== 409 && status !== 429) {
    return new DisputeReadError(error.code ?? `http_${status}`, false);
  }
  return new DisputeReadError(error.code ?? error.type, true);
}

export function toDisputeSnapshot(dispute: Stripe.Dispute): DisputeSnapshot {
  const paymentIntent = dispute.payment_intent;
  // Stripe sends 0 when the card network allows no response; that is no deadline, not 1970.
  const dueBy = dispute.evidence_details?.due_by ?? null;
  return {
    providerDisputeId: dispute.id,
    paymentIntentId:
      paymentIntent === null || paymentIntent === undefined
        ? null
        : typeof paymentIntent === "string"
          ? paymentIntent
          : paymentIntent.id,
    amountMinor: dispute.amount,
    currency: dispute.currency.toUpperCase(),
    reason: dispute.reason,
    status: dispute.status,
    evidenceDueBy: dueBy ? new Date(dueBy * 1000) : null,
  };
}
