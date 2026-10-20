import type Stripe from "stripe";
import type { FraudWarningEvent } from "./provider";

/**
 * The early-fraud-warning half of the Stripe adapter (audit s104 PAY-4).
 * Like stripe-refunds.ts and stripe-disputes.ts, the only place that knows
 * this shape is Stripe's.
 *
 * Only `created` is acted on. `updated` only ever turns `actionable` off
 * (the payment was disputed or refunded since), which the dispute and refund
 * events already tell us about.
 */

export const FRAUD_WARNING_EVENTS = new Set(["radar.early_fraud_warning.created"]);

/** The network's category, cut to what the table keeps; it is shown to the desk, never parsed. */
const MAX_FRAUD_TYPE = 60;

export function toFraudWarningEvent(event: Stripe.Event): FraudWarningEvent {
  const warning = event.data.object as Stripe.Radar.EarlyFraudWarning;
  const paymentIntent = warning.payment_intent;
  return {
    kind: "fraud_warning",
    eventId: event.id,
    type: event.type,
    occurredAt: new Date(event.created * 1000),
    ignorable: false,
    providerWarningId: warning.id,
    paymentIntentId:
      paymentIntent === null || paymentIntent === undefined
        ? null
        : typeof paymentIntent === "string"
          ? paymentIntent
          : paymentIntent.id,
    fraudType: (warning.fraud_type || "unknown").slice(0, MAX_FRAUD_TYPE),
    actionable: warning.actionable === true,
  };
}
