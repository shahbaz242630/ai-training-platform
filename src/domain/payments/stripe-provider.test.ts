import Stripe from "stripe";
import { describe, it, expect } from "vitest";
import { StripePaymentProvider, outcomeFor, toPaymentEvent } from "./stripe-provider";
import { InvalidSignatureError } from "./provider";

/**
 * The REAL adapter, against the REAL Stripe SDK.
 *
 * No network and no account: the SDK can both generate a valid signature
 * header and verify one, so the control that actually protects this
 * integration - webhook signature verification - is proven here rather than
 * assumed. A test that only exercised our mock would prove that our mock
 * agrees with itself.
 */

const SIGNING_SECRET = "whsec_test_secret_for_verification_only";
const stripe = new Stripe("sk_test_not_a_real_key", { apiVersion: "2026-08-26.dahlia" });

const provider = new StripePaymentProvider(stripe, SIGNING_SECRET);

const eventBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: "evt_test_1",
    object: "event",
    created: 1800000000,
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        object: "checkout.session",
        payment_status: "paid",
        amount_total: 129900,
        currency: "aed",
        client_reference_id: "order-1",
        metadata: { orderId: "order-1", slotHoldId: "hold-1" },
      },
    },
    ...overrides,
  });

const signedHeader = (body: string) =>
  stripe.webhooks.generateTestHeaderString({ payload: body, secret: SIGNING_SECRET });

describe("StripePaymentProvider.verifyEvent", () => {
  it("accepts a genuinely signed delivery and reduces it to our shape", async () => {
    const body = eventBody();
    const event = await provider.verifyEvent(body, signedHeader(body));

    expect(event.eventId).toBe("evt_test_1");
    expect(event.orderId).toBe("order-1");
    expect(event.slotHoldId).toBe("hold-1");
    expect(event.outcome).toBe("paid");
    expect(event.amountFils).toBe(129900);
    expect(event.ignorable).toBe(false);
  });

  it("refuses a delivery with no signature header", async () => {
    await expect(provider.verifyEvent(eventBody(), null)).rejects.toThrow(InvalidSignatureError);
  });

  it("refuses a forged signature", async () => {
    const body = eventBody();
    await expect(provider.verifyEvent(body, "t=1800000000,v1=" + "0".repeat(64))).rejects.toThrow(
      InvalidSignatureError,
    );
  });

  /*
    A signature covers exact bytes. This is why the raw body must be verified
    and never a re-serialised object - JSON that has been parsed and stringified
    again is different bytes, and would fail here exactly as this does.
  */
  it("refuses a body altered after signing", async () => {
    const body = eventBody();
    const header = signedHeader(body);
    const tampered = body.replace("129900", "100");

    await expect(provider.verifyEvent(tampered, header)).rejects.toThrow(InvalidSignatureError);
  });

  it("refuses a signature made with a different secret", async () => {
    const body = eventBody();
    const wrong = stripe.webhooks.generateTestHeaderString({
      payload: body,
      secret: "whsec_a_different_secret",
    });

    await expect(provider.verifyEvent(body, wrong)).rejects.toThrow(InvalidSignatureError);
  });
});

/*
  What we actually send to Stripe.

  These assertions are about money and about tax, so they are worth more than
  the rest of this file combined. A stub captures the arguments; nothing here
  reaches the network.
*/
describe("StripePaymentProvider.startCheckout", () => {
  interface Captured {
    params?: Stripe.Checkout.SessionCreateParams;
    options?: Stripe.RequestOptions;
  }

  const providerWithStub = (captured: Captured, url: string | null = "https://pay.stripe/x") => {
    const stub = {
      checkout: {
        sessions: {
          create: (params: Stripe.Checkout.SessionCreateParams, options: Stripe.RequestOptions) => {
            captured.params = params;
            captured.options = options;
            return Promise.resolve({ id: "cs_test_created", url });
          },
        },
      },
    } as unknown as Stripe;
    return new StripePaymentProvider(stub, SIGNING_SECRET);
  };

  const input = {
    line: {
      slug: "ai-foundations",
      title: "AI Foundations",
      amountFils: 129900,
      currency: "AED" as const,
    },
    orderId: "order-42",
    customerEmail: "amina@example.com",
    slotHoldId: "hold-42",
    successUrl: "https://example.com/ok",
    cancelUrl: "https://example.com/cancel",
    idempotencyKey: "order-42",
  };

  /*
    Fils are already the minor unit. Any division on this path would make the
    charge wrong by a factor of a hundred, in whichever direction is worse.
  */
  it("sends the amount in fils exactly as resolved, with no arithmetic", async () => {
    const captured: Captured = {};
    await providerWithStub(captured).startCheckout(input);

    expect(captured.params?.line_items?.[0]?.price_data?.unit_amount).toBe(129900);
    expect(captured.params?.line_items?.[0]?.price_data?.currency).toBe("aed");
  });

  /*
    Omitting payment_method_types is what enables dynamic payment methods.
    Hardcoding a card-only list is a conversion loss for no gain, so its
    ABSENCE is asserted rather than left to a reviewer to notice.
  */
  it("never sends payment_method_types", async () => {
    const captured: Captured = {};
    await providerWithStub(captured).startCheckout(input);

    expect(captured.params).not.toHaveProperty("payment_method_types");
  });

  /*
    Stripe Tax collects NOTHING without an active registration while appearing
    to be switched on. Until a TRN exists, this being off is a correctness
    requirement, not a preference.
  */
  it("keeps automatic tax switched off", async () => {
    const captured: Captured = {};
    await providerWithStub(captured).startCheckout(input);

    expect(captured.params?.automatic_tax?.enabled).toBe(false);
  });

  // Without this, a retry creates a second checkout and a second charge.
  it("passes an idempotency key derived from the order", async () => {
    const captured: Captured = {};
    await providerWithStub(captured).startCheckout(input);

    expect(captured.options?.idempotencyKey).toBe("order-42");
  });

  /*
    The webhook has to find our order and the slot it is paying for without
    trusting anything a browser sends back to a success URL.
  */
  it("carries the order and slot hold on both the session and the payment intent", async () => {
    const captured: Captured = {};
    await providerWithStub(captured).startCheckout(input);

    expect(captured.params?.metadata).toMatchObject({
      orderId: "order-42",
      slotHoldId: "hold-42",
    });
    expect(captured.params?.payment_intent_data?.metadata).toMatchObject({
      orderId: "order-42",
      slotHoldId: "hold-42",
    });
    expect(captured.params?.client_reference_id).toBe("order-42");
  });

  // A session with nowhere to send the customer is a failure, not a success.
  it("refuses a session that came back without a URL", async () => {
    const captured: Captured = {};
    await expect(providerWithStub(captured, null).startCheckout(input)).rejects.toThrow();
  });
});

/*
  The rule that decides whether somebody gets the session they paid for.
  Tested directly, because it is a pure function and the cases that matter are
  the ones a live sandbox would rarely produce on demand.
*/
describe("outcomeFor", () => {
  it("treats a paid session as paid", () => {
    expect(outcomeFor("checkout.session.completed", "paid")).toBe("paid");
  });

  /*
    THE trap. With a delayed-notification method the completed event arrives
    while the session is still unpaid, and the money may never come. Reading
    the event NAME as success confirms bookings for payments that bounce.
  */
  it("treats a completed but unpaid session as unpaid", () => {
    expect(outcomeFor("checkout.session.completed", "unpaid")).toBe("unpaid");
  });

  it("treats the later async success as paid", () => {
    expect(outcomeFor("checkout.session.async_payment_succeeded", "paid")).toBe("paid");
  });

  /*
    The event name wins for failures. An async failure can still arrive
    carrying a stale status, and reading that status as authority there would
    confirm a booking for a payment that explicitly failed.
  */
  it("treats an async failure as failed whatever the status says", () => {
    expect(outcomeFor("checkout.session.async_payment_failed", "paid")).toBe("failed");
    expect(outcomeFor("checkout.session.expired", "paid")).toBe("failed");
  });

  // A zero-amount session is legitimately settled without a payment.
  it("treats no_payment_required as paid", () => {
    expect(outcomeFor("checkout.session.completed", "no_payment_required")).toBe("paid");
  });

  it("treats a missing status as unpaid rather than assuming the best", () => {
    expect(outcomeFor("checkout.session.completed", null)).toBe("unpaid");
  });
});

describe("toPaymentEvent", () => {
  const event = (type: string, object: Record<string, unknown> = {}) =>
    ({
      id: "evt_x",
      created: 1800000000,
      type,
      data: { object: { id: "cs_x", ...object } },
    }) as unknown as Stripe.Event;

  /*
    Stripe sends far more event types than we consume. Marking an unknown one
    ignorable rather than failing is what stops the endpoint returning 500 and
    being retried forever.
  */
  it("marks an event type we do not consume as ignorable", () => {
    const reduced = toPaymentEvent(event("customer.subscription.updated"));
    expect(reduced.ignorable).toBe(true);
    expect(reduced.orderId).toBeNull();
  });

  it("falls back to client_reference_id when metadata is missing", () => {
    const reduced = toPaymentEvent(
      event("checkout.session.completed", {
        client_reference_id: "order-9",
        payment_status: "paid",
      }),
    );
    expect(reduced.orderId).toBe("order-9");
  });

  it("prefers metadata over client_reference_id", () => {
    const reduced = toPaymentEvent(
      event("checkout.session.completed", {
        client_reference_id: "order-old",
        metadata: { orderId: "order-new" },
        payment_status: "paid",
      }),
    );
    expect(reduced.orderId).toBe("order-new");
  });

  // Stripe reports seconds; everything we store is a real Date in UTC.
  it("converts the Stripe timestamp from seconds", () => {
    const reduced = toPaymentEvent(event("checkout.session.completed", { payment_status: "paid" }));
    expect(reduced.occurredAt.toISOString()).toBe("2027-01-15T08:00:00.000Z");
  });
});
