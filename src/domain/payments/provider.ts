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

/** A payment event, already verified and reduced to what this application needs. */
export interface PaymentEvent {
  /** The processor's event id. Persisted, so a duplicate delivery is a no-op. */
  readonly eventId: string;
  readonly type: string;
  readonly checkoutSessionId: string | null;
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

export interface PaymentProvider {
  /** Create a hosted checkout and return where to send the customer. */
  startCheckout(input: StartCheckoutInput): Promise<StartedCheckout>;

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
}
