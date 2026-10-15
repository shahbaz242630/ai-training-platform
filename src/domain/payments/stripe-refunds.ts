import Stripe from "stripe";
import {
  RefundRefusedError,
  RefundUnclearError,
  type RefundEvent,
  type RefundSnapshot,
  type RefundStatus,
} from "./provider";

/**
 * The refund half of the Stripe adapter: reading refund events and refunds,
 * and sorting Stripe's errors into the two kinds the issuer acts on.
 *
 * Split from stripe-provider.ts only for size. Like that file, it is the only
 * place that knows these shapes are Stripe's.
 */

export const REFUND_EVENTS = new Set(["refund.created", "refund.updated", "refund.failed"]);

/** Our keys on the refund's metadata, so an event can find the row that asked for it. */
const ORDER_ID = "orderId";
const REFUND_ID = "refundId";

/*
  Stripe types the status as a free string. The four we act on are kept; any
  other value, or none, is still in flight as far as we can tell. Storing it
  as `pending` keeps the row visible to the alarm instead of failing an insert
  and having the event retried for days.
*/
const KNOWN: ReadonlySet<string> = new Set(["pending", "succeeded", "failed", "canceled"]);

export function refundStatusOf(status: string | null): RefundStatus {
  return status !== null && KNOWN.has(status) ? (status as RefundStatus) : "pending";
}

function paymentIntentIdOf(paymentIntent: Stripe.Refund["payment_intent"]): string | null {
  if (!paymentIntent) return null;
  return typeof paymentIntent === "string" ? paymentIntent : paymentIntent.id;
}

export function toRefundEvent(event: Stripe.Event): RefundEvent {
  const refund = event.data.object as Stripe.Refund;
  return {
    kind: "refund",
    eventId: event.id,
    type: event.type,
    occurredAt: new Date(event.created * 1000),
    ignorable: false,
    orderId: refund.metadata?.[ORDER_ID] ?? null,
    refundRowId: refund.metadata?.[REFUND_ID] ?? null,
    providerRefundId: refund.id,
    paymentIntentId: paymentIntentIdOf(refund.payment_intent),
    amountFils: refund.amount,
    currency: refund.currency.toUpperCase(),
    status: refundStatusOf(refund.status),
  };
}

export function toRefundSnapshot(refund: Stripe.Refund): RefundSnapshot {
  return {
    providerRefundId: refund.id,
    status: refundStatusOf(refund.status),
    amountFils: refund.amount,
    currency: refund.currency.toUpperCase(),
    paymentIntentId: paymentIntentIdOf(refund.payment_intent),
  };
}

/** Codes that mean an earlier request with the same key may still be running. */
const IN_FLIGHT: ReadonlySet<string> = new Set(["idempotency_key_in_use", "lock_timeout"]);

/**
 * Which kind of failure this is.
 *
 * UNCLEAR when the request may have gone through: no answer, a dropped
 * connection, Stripe failing on its side, a rate limit, or another request
 * with the same key still running. These are repeated with the same key.
 *
 * REFUSED when Stripe answered with a 4xx and a code: nothing was made, so a
 * new key is safe. Only the code is kept. Stripe's message can repeat what we
 * sent, and it does not belong in a log or a column.
 *
 * Anything we do not recognise is unclear. Guessing "refused" would let the
 * next attempt use a new key, and a new key is how a refund is made twice.
 */
export function classifyRefundError(error: unknown): RefundUnclearError | RefundRefusedError {
  if (!(error instanceof Stripe.errors.StripeError)) return new RefundUnclearError("unknown");
  if (
    error instanceof Stripe.errors.StripeConnectionError ||
    error instanceof Stripe.errors.StripeAPIError ||
    error instanceof Stripe.errors.StripeRateLimitError ||
    error instanceof Stripe.errors.StripeIdempotencyError
  ) {
    return new RefundUnclearError(error.code ?? error.type);
  }
  /*
    Before the 4xx rule. Another request with this key still running comes
    back as an ordinary invalid-request error with status 409, and a lock
    timeout as a 4xx too; both mean the first request may yet succeed, so the
    key must not move on.
  */
  if (error.statusCode === 409 || (error.code !== undefined && IN_FLIGHT.has(error.code))) {
    return new RefundUnclearError(error.code ?? "conflict");
  }
  const status = error.statusCode ?? 0;
  if (status >= 400 && status < 500 && error.code) return new RefundRefusedError(error.code);
  return new RefundUnclearError(error.code ?? error.type);
}
