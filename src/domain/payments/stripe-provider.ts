import Stripe from "stripe";
import { serverEnv } from "@/lib/env";
import {
  InvalidSignatureError,
  PaymentNotConfiguredError,
  type PaymentEvent,
  type PaymentOutcome,
  type PaymentProvider,
  type StartCheckoutInput,
  type StartedCheckout,
} from "./provider";

/**
 * Stripe behind the payment port.
 *
 * Everything Stripe-specific lives in this file. Nothing else in the
 * application imports the SDK, so replacing the processor is a new file and a
 * changed factory rather than a search across the codebase.
 */

/*
  Pinned. Stripe changes response shapes between versions, and letting the
  account default decide which one we get means a dashboard setting can alter
  what our code parses, with no deploy and no warning.

  The value is taken from the INSTALLED SDK (node_modules/stripe/cjs/apiVersion.js),
  not from documentation. The two disagreed - published guidance said
  2026-07-29.dahlia while the shipped types accept only 2026-08-26.dahlia - and
  the package we actually call is the one that decides. Typecheck enforces
  this: a wrong value here does not compile.
*/
const API_VERSION = "2026-08-26.dahlia";

/**
 * The events this integration acts on.
 *
 * `completed` alone is NOT enough. With a delayed-notification payment method
 * it arrives while the session is still unpaid and the money lands hours
 * later - so acting only on it would confirm sessions for payments that later
 * fail, and never confirm the ones that eventually succeed.
 */
const COMPLETED = "checkout.session.completed";
const ASYNC_SUCCEEDED = "checkout.session.async_payment_succeeded";
const ASYNC_FAILED = "checkout.session.async_payment_failed";
const EXPIRED = "checkout.session.expired";

const HANDLED_EVENTS = new Set([COMPLETED, ASYNC_SUCCEEDED, ASYNC_FAILED, EXPIRED]);

/**
 * How long a customer has to pay.
 *
 * Stripe will not accept an expiry sooner than 30 minutes from creation, so
 * this is its floor. Left unset, a session lives TWENTY-FOUR HOURS: somebody
 * could open checkout, be interrupted, pay the next morning, and be charged
 * for a slot released long before - a routine outcome dressed up as an edge
 * case, and one that needs a human to unpick every time.
 *
 * The slot hold deliberately outlives this (DEFAULT_HOLD_TTL_MINUTES), so a
 * payment the processor still accepts always has a slot waiting for it.
 */
const CHECKOUT_SESSION_TTL_MINUTES = 30;

/** Our own keys on the Stripe object, so an event can find its order and its slot. */
const ORDER_ID = "orderId";
const SLOT_HOLD_ID = "slotHoldId";

export class StripePaymentProvider implements PaymentProvider {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  /**
   * The client is constructed as an instance, never by setting a global key.
   * The module-level pattern is deprecated in the current SDKs, and a global
   * key is a value any other module can quietly change.
   */
  constructor(stripe?: Stripe, webhookSecret?: string) {
    const env = serverEnv();

    if (stripe) {
      this.stripe = stripe;
    } else {
      if (!env.STRIPE_SECRET_KEY) throw new PaymentNotConfiguredError("STRIPE_SECRET_KEY");
      this.stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: API_VERSION });
    }

    const secret = webhookSecret ?? env.STRIPE_WEBHOOK_SECRET;
    /*
      Asserted here rather than where a webhook arrives. A provider that
      constructs without a signing secret is one that will accept its first
      real delivery unverified, and that failure would surface at the worst
      possible moment.
    */
    if (!secret) throw new PaymentNotConfiguredError("STRIPE_WEBHOOK_SECRET");
    this.webhookSecret = secret;
  }

  async startCheckout(input: StartCheckoutInput): Promise<StartedCheckout> {
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: "payment",
        /*
          NO payment_method_types. Omitting it enables dynamic payment
          methods, so Stripe shows each customer the methods most likely to
          convert for them, configured from the dashboard rather than from a
          deploy. Hardcoding a card-only list is a conversion loss for no gain.
        */
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.line.currency.toLowerCase(),
              /*
                Fils are already the minor unit, which is what Stripe wants.
                No division happens anywhere on this path - converting to a
                major unit and back is how a price becomes wrong by a factor
                of a hundred.
              */
              unit_amount: input.line.amountFils,
              product_data: { name: input.line.title },
            },
          },
        ],
        customer_email: input.customerEmail,
        client_reference_id: input.orderId,
        /*
          Carried on the session so a webhook can find our order and the slot
          hold it is paying for, without trusting anything a browser sends
          back to a success URL.
        */
        metadata: { [ORDER_ID]: input.orderId, [SLOT_HOLD_ID]: input.slotHoldId },
        // Repeated on the PaymentIntent: a refund or a dispute is read from
        // there, and metadata does not travel down on its own.
        payment_intent_data: {
          metadata: { [ORDER_ID]: input.orderId, [SLOT_HOLD_ID]: input.slotHoldId },
        },
        /*
          NOT enabled. Stripe Tax calculates and collects nothing without an
          active registration in the customer jurisdiction, while appearing to
          be switched on - which is the most common way to believe tax is
          being handled when it is not. Turn this on with a TRN, not before.
        */
        automatic_tax: { enabled: false },
        /*
          Bounded rather than left to the 24-hour default. An expiry here turns
          "paid far too late for the slot we reserved" into an ordinary expired
          session that releases cleanly, instead of a charge with no session.
        */
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_SESSION_TTL_MINUTES * 60,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
      },
      // A retried create with the same key returns the ORIGINAL session
      // instead of making a second one. Derived from our order id, because a
      // random key on a retry is not idempotency, it is a second charge.
      { idempotencyKey: input.idempotencyKey },
    );

    if (!session.url) {
      throw new PaymentNotConfiguredError("Stripe returned a checkout session with no URL");
    }

    return { checkoutSessionId: session.id, redirectUrl: session.url };
  }

  async verifyEvent(rawBody: string, signatureHeader: string | null): Promise<PaymentEvent> {
    if (signatureHeader === null) throw new InvalidSignatureError("No signature header was sent");

    let event: Stripe.Event;
    try {
      /*
        Verified against the RAW bytes. Stripe signs the body exactly as sent,
        so anything that has been parsed and re-serialised will not verify -
        and code that fixes that by parsing first is code that verifies
        nothing at all.
      */
      event = await this.stripe.webhooks.constructEventAsync(
        rawBody,
        signatureHeader,
        this.webhookSecret,
      );
    } catch (error) {
      // Deliberately not echoed back to the caller. A forged delivery learns
      // only that it was rejected.
      throw new InvalidSignatureError(`Signature verification failed: ${(error as Error).message}`);
    }

    return toPaymentEvent(event);
  }
}

/** Stripe shapes in, our shape out. Nothing above this line knows Stripe exists. */
export function toPaymentEvent(event: Stripe.Event): PaymentEvent {
  const base = {
    eventId: event.id,
    type: event.type,
    occurredAt: new Date(event.created * 1000),
  };

  if (!HANDLED_EVENTS.has(event.type)) {
    /*
      Stripe sends far more event types than any integration consumes. An
      unrecognised one is ignorable, NOT an error - treating it as a failure
      would make the endpoint return 500 and Stripe retry it forever.
    */
    return {
      ...base,
      checkoutSessionId: null,
      paymentIntentId: null,
      orderId: null,
      slotHoldId: null,
      outcome: "unpaid",
      amountFils: null,
      currency: null,
      ignorable: true,
    };
  }

  const session = event.data.object as Stripe.Checkout.Session;

  return {
    ...base,
    checkoutSessionId: session.id,
    paymentIntentId: paymentIntentIdOf(session.payment_intent),
    orderId: session.metadata?.[ORDER_ID] ?? session.client_reference_id ?? null,
    slotHoldId: session.metadata?.[SLOT_HOLD_ID] ?? null,
    outcome: outcomeFor(event.type, session.payment_status),
    amountFils: session.amount_total,
    currency: session.currency,
    ignorable: false,
  };
}

/**
 * The payment behind a checkout session, by id.
 *
 * Stripe sends `payment_intent` as a bare id, as the whole object when the
 * field was expanded, or as null while nothing has been paid. Only the id is
 * kept: it is what a refund names, and the session id cannot do that job.
 * This was left unread for the first real payment, and the column stayed null.
 */
function paymentIntentIdOf(
  paymentIntent: Stripe.Checkout.Session["payment_intent"],
): string | null {
  if (!paymentIntent) return null;
  return typeof paymentIntent === "string" ? paymentIntent : paymentIntent.id;
}

/**
 * What actually happened to the money.
 *
 * `payment_status` is the authority, not the event name. A completed session
 * whose status is still `unpaid` is a delayed payment in flight: real money
 * may yet arrive, and may yet not. Confirming a booking on that is how
 * somebody gets a session for a payment that bounces a day later.
 */
export function outcomeFor(
  eventType: string,
  paymentStatus: Stripe.Checkout.Session.PaymentStatus | null,
): PaymentOutcome {
  if (eventType === ASYNC_FAILED || eventType === EXPIRED) return "failed";
  if (paymentStatus === "paid" || paymentStatus === "no_payment_required") return "paid";
  return "unpaid";
}
