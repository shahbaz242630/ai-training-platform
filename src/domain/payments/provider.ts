import type { Currency, Fils } from "@/lib/money";

/**
 * The payment port.
 *
 * Everything that takes money talks to this interface, never to a vendor SDK.
 * A route that calls Stripe directly cannot be tested without live
 * credentials, cannot run for a contributor who has none, and welds the
 * booking flow to one processor. Two implementations sit behind it: an
 * in-memory one used by tests and local development, and the real Stripe
 * adapter.
 *
 * The shape follows what a booking actually needs:
 *
 *     start checkout  ->  customer pays  ->  WE ARE TOLD BY A SIGNED EVENT
 *
 * The third step is the one that matters. A booking is confirmed only by a
 * verified webhook, never because a browser reached a success page - somebody
 * can pay and lose their connection before the page loads, and somebody else
 * can open the success URL having paid nothing at all.
 */

/** What the customer is buying. Resolved server-side from the catalogue, never sent by a browser. */
export interface CheckoutLine {
  readonly slug: string;
  readonly title: string;
  readonly amountFils: Fils;
  readonly currency: Currency;
}

export interface StartCheckoutInput {
  readonly line: CheckoutLine;
  /** Our order id. Comes back on the event, and is how a payment finds its booking. */
  readonly orderId: string;
  readonly customerEmail: string;
  /** The slot hold this payment is for, so a confirmed payment converts the right claim. */
  readonly slotHoldId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /**
   * Sent to the processor so a retried request cannot create a second charge.
   * Derived from our order, not random: a retry must reuse the same value or
   * it is not idempotent at all.
   */
  readonly idempotencyKey: string;
}

export interface StartedCheckout {
  /** The processor's session id. Stored so an event can be matched to an order. */
  readonly checkoutSessionId: string;
  /** Where to send the customer. */
  readonly redirectUrl: string;
}

/**
 * Whether the money actually arrived.
 *
 * Deliberately NOT a boolean. With delayed-notification payment methods a
 * checkout completes while still unpaid, and the payment succeeds or fails
 * hours later. Collapsing that to true//false is how somebody gets a confirmed
 * session for a payment that later bounces.
 */
export type PaymentOutcome = "paid" | "unpaid" | "failed";

/** A checkout event, already verified and reduced to what this application needs. */
export interface CheckoutEvent {
  readonly kind: "checkout";
  /** The processor's event id. Persisted, so a duplicate delivery is a no-op. */
  readonly eventId: string;
  readonly type: string;
  readonly checkoutSessionId: string | null;
  /**
   * The processor's handle on the payment itself, once one exists. A checkout
   * session cannot be refunded; the payment behind it can, and this is how a
   * refund names it. Null until money has actually moved, and on events that
   * carry no payment at all.
   */
  readonly paymentIntentId: string | null;
  readonly orderId: string | null;
  readonly slotHoldId: string | null;
  readonly outcome: PaymentOutcome;
  readonly amountFils: Fils | null;
  readonly currency: string | null;
  readonly occurredAt: Date;
  /**
   * True when this event type has nothing to do with booking. Handlers ignore
   * it rather than treating an unrecognised event as a failure - a processor
   * sends far more event types than any one integration consumes.
   */
  readonly ignorable: boolean;
}

/**
 * Where a refund stands, as the processor says.
 *
 * `pending` covers everything still in flight. A status the processor adds
 * later is read as `pending` too, never as an error: an event we cannot store
 * would be retried for days, and a refund we do not understand yet is one a
 * person should look at, not one to drop.
 */
export type RefundStatus = "pending" | "succeeded" | "failed" | "canceled";

/**
 * A refund event, verified. Refunds made in the processor's dashboard carry
 * none of our metadata, so the order is found from the payment instead.
 */
export interface RefundEvent {
  readonly kind: "refund";
  readonly eventId: string;
  readonly type: string;
  readonly occurredAt: Date;
  readonly ignorable: false;
  /** Our order id from the refund's metadata; null for a refund made elsewhere. */
  readonly orderId: string | null;
  /** Our refunds row id from the metadata; null for a refund made elsewhere. */
  readonly refundRowId: string | null;
  readonly providerRefundId: string;
  /** The payment refunded. Null only for a refund of a bare charge, which is never ours. */
  readonly paymentIntentId: string | null;
  readonly amountFils: Fils;
  readonly currency: string;
  readonly status: RefundStatus;
}

export type PaymentEvent = CheckoutEvent | RefundEvent;

/** A checkout session as the processor has it now: what its event would have said. */
export type CheckoutSnapshot = Pick<
  CheckoutEvent,
  | "checkoutSessionId"
  | "paymentIntentId"
  | "orderId"
  | "slotHoldId"
  | "outcome"
  | "amountFils"
  | "currency"
>;

export interface RefundPaymentInput {
  readonly paymentIntentId: string;
  readonly amountFils: Fils;
  /**
   * Derived from our refunds row and its key generation, never random. A
   * request that may have gone through is repeated with the same key, so the
   * processor answers with the refund it already made instead of a second one.
   */
  readonly idempotencyKey: string;
  readonly metadata: { readonly orderId: string; readonly refundId: string };
}

export interface IssuedRefund {
  readonly providerRefundId: string;
  readonly status: RefundStatus;
}

export interface RefundSnapshot extends IssuedRefund {
  readonly amountFils: Fils;
  readonly currency: string;
  readonly paymentIntentId: string | null;
}

/** Base type, so every payment failure can be caught in one place. */
export class PaymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentError";
  }
}

/**
 * The signature did not verify.
 *
 * Its own type because the response is different in kind: a bad signature is
 * not a failed payment, it is an unauthenticated request pretending to be
 * one, and it must never reach the code that confirms bookings.
 */
export class InvalidSignatureError extends PaymentError {
  constructor(message = "The webhook signature did not verify") {
    super(message);
    this.name = "InvalidSignatureError";
  }
}

/** The provider is not configured - no key, no secret. Distinct from a rejected payment. */
export class PaymentNotConfiguredError extends PaymentError {
  constructor(what: string) {
    super(`${what} is not configured, so payments cannot be taken`);
    this.name = "PaymentNotConfiguredError";
  }
}

/** Refusals that mean the money already went back, so asking again would never succeed. */
const ALREADY_REFUNDED_CODES = new Set(["charge_already_refunded", "amount_too_large"]);

/**
 * A refund request whose result is not known: the connection dropped, the
 * request timed out, the processor failed on its side, or another request with
 * the same key is still running. It may have gone through, so it is repeated
 * later with the SAME idempotency key, never a new one.
 */
export class RefundUnclearError extends PaymentError {
  constructor(readonly code: string) {
    super(`The refund request has no clear result (${code})`);
    this.name = "RefundUnclearError";
  }
}

/**
 * The processor refused the request and made nothing. `code` is its error
 * code, kept so a person can see why; the message is not kept, since it can
 * repeat what was sent.
 */
export class RefundRefusedError extends PaymentError {
  constructor(readonly code: string) {
    super(`The refund was refused (${code})`);
    this.name = "RefundRefusedError";
  }

  /** The payment has nothing left to refund: somebody refunded it another way. */
  get alreadyRefunded(): boolean {
    return ALREADY_REFUNDED_CODES.has(this.code);
  }
}

export interface PaymentProvider {
  /** Create a hosted checkout and return where to send the customer. */
  startCheckout(input: StartCheckoutInput): Promise<StartedCheckout>;

  /**
   * End a checkout that has no slot behind it any more, so it can no longer be
   * paid. Used when a customer starts another checkout and their first hold is
   * released. Throws on failure; the caller logs it, and the session still
   * ends by itself at its own expiry.
   */
  expireCheckout(checkoutSessionId: string): Promise<void>;

  /**
   * Verify a webhook delivery and reduce it to a PaymentEvent.
   *
   * Takes the RAW body, not a parsed object. A signature is computed over
   * exact bytes, and JSON that has been parsed and re-serialised is no longer
   * those bytes - verifying a re-encoded body is verifying nothing.
   *
   * Throws InvalidSignatureError when verification fails. It never returns a
   * "this one was not valid" result, because a caller can ignore a result and
   * cannot ignore a throw.
   */
  verifyEvent(rawBody: string, signatureHeader: string | null): Promise<PaymentEvent>;

  /**
   * Refund a payment. Throws RefundUnclearError when the result is unknown and
   * RefundRefusedError when the processor clearly made nothing.
   */
  refundPayment(input: RefundPaymentInput): Promise<IssuedRefund>;

  /** Read a refund as the processor has it now. */
  getRefund(providerRefundId: string): Promise<RefundSnapshot>;

  /**
   * The country the card behind a payment was issued in, as an upper-case
   * two-letter code, or null when the payment was not made by card or the
   * processor does not say. Throws when the processor cannot be asked; the
   * caller treats that as unknown.
   */
  getCardCountry(paymentIntentId: string): Promise<string | null>;

  /**
   * Read a checkout session as the processor has it now. How an order is
   * settled when its event never arrived: the same facts, asked for.
   */
  getCheckoutSnapshot(checkoutSessionId: string): Promise<CheckoutSnapshot>;
}
