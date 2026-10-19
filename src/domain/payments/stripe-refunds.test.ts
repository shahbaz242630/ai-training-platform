import Stripe from "stripe";
import { describe, it, expect } from "vitest";
import { StripePaymentProvider, toPaymentEvent } from "./stripe-provider";
import { classifyRefundError, refundStatusOf } from "./stripe-refunds";
import { RefundRefusedError, RefundUnclearError, type RefundEvent } from "./provider";

/**
 * Refunds through the REAL adapter. A stub client captures what would be sent
 * to Stripe; nothing reaches the network. These are the assertions that decide
 * whether money goes back once, in full, to the right payment.
 */

const SIGNING_SECRET = "whsec_test_secret_for_verification_only";

interface Captured {
  params?: Stripe.RefundCreateParams;
  options?: Stripe.RequestOptions;
}

const withRefunds = (refunds: Record<string, unknown>) =>
  new StripePaymentProvider({ refunds } as unknown as Stripe, SIGNING_SECRET);

const input = {
  paymentIntentId: "pi_123",
  amountFils: 129900,
  idempotencyKey: "refund:row-1:0",
  metadata: { orderId: "order-1", refundId: "row-1" },
};

describe("StripePaymentProvider.refundPayment", () => {
  it("refunds exactly that payment, in full, with our key and our ids", async () => {
    const captured: Captured = {};
    const provider = withRefunds({
      create: (params: Stripe.RefundCreateParams, options: Stripe.RequestOptions) => {
        captured.params = params;
        captured.options = options;
        return Promise.resolve({ id: "re_1", status: "pending" });
      },
    });

    const issued = await provider.refundPayment(input);

    expect(issued).toEqual({ providerRefundId: "re_1", status: "pending" });
    expect(captured.params).toEqual({
      payment_intent: "pi_123",
      amount: 129900,
      reason: "requested_by_customer",
      metadata: { orderId: "order-1", refundId: "row-1" },
    });
    expect(captured.options?.idempotencyKey).toBe("refund:row-1:0");
    // Bounded, so one slow answer cannot hold the sweep.
    expect(captured.options?.timeout).toBeGreaterThan(0);
    expect(captured.options?.timeout).toBeLessThanOrEqual(20_000);
    // Set, not left to the SDK: the claim's five-minute lease is sized for these tries.
    expect(captured.options?.maxNetworkRetries).toBe(1);
    const worst =
      (captured.options?.timeout ?? 0) * ((captured.options?.maxNetworkRetries ?? 0) + 1);
    expect(worst).toBeLessThan((5 * 60_000) / 4);
  });

  /*
    The shape stripe-node actually gives for a second request with a key
    still in use: an ordinary invalid-request error with status 409. Read as
    a refusal, the next attempt would get a new key while the first request
    might still succeed, and the customer could be refunded twice.
  */
  it("reports a key still in use as unclear, so the key is kept", async () => {
    const provider = withRefunds({
      create: () =>
        Promise.reject(
          new Stripe.errors.StripeInvalidRequestError({
            type: "invalid_request_error",
            code: "idempotency_key_in_use",
            message: "There is currently another in-progress request using this key.",
            statusCode: 409,
          } as never),
        ),
    });
    const error = await provider.refundPayment(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefundUnclearError);
    expect((error as RefundUnclearError).code).toBe("idempotency_key_in_use");
  });

  it("reports a refused request as refused, with its code", async () => {
    const provider = withRefunds({
      create: () =>
        Promise.reject(
          new Stripe.errors.StripeInvalidRequestError({
            type: "invalid_request_error",
            code: "charge_already_refunded",
            message: "Charge ch_1 has already been refunded.",
            statusCode: 400,
          } as never),
        ),
    });
    const error = await provider.refundPayment(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefundRefusedError);
    expect((error as RefundRefusedError).code).toBe("charge_already_refunded");
    expect((error as RefundRefusedError).alreadyRefunded).toBe(true);
  });

  it("reports a dropped connection as unclear, so the same key is used again", async () => {
    const provider = withRefunds({
      create: () =>
        Promise.reject(
          new Stripe.errors.StripeConnectionError({ message: "socket hang up" } as never),
        ),
    });
    await expect(provider.refundPayment(input)).rejects.toBeInstanceOf(RefundUnclearError);
  });
});

describe("StripePaymentProvider.getRefund", () => {
  it("reads the refund as Stripe has it now", async () => {
    const provider = withRefunds({
      retrieve: (id: string) =>
        Promise.resolve({
          id,
          status: "succeeded",
          amount: 129900,
          currency: "aed",
          payment_intent: { id: "pi_9", object: "payment_intent" },
        }),
    });
    expect(await provider.getRefund("re_7")).toEqual({
      providerRefundId: "re_7",
      status: "succeeded",
      amountFils: 129900,
      currency: "AED",
      paymentIntentId: "pi_9",
    });
  });
});

describe("StripePaymentProvider.getCardCountry", () => {
  const withIntent = (latestCharge: unknown, seen: unknown[] = []) =>
    new StripePaymentProvider(
      {
        paymentIntents: {
          retrieve: (...args: unknown[]) => {
            seen.push(args);
            return Promise.resolve({ id: "pi_1", latest_charge: latestCharge });
          },
        },
      } as unknown as Stripe,
      SIGNING_SECRET,
    );

  it("reads the issuing country of the card from the payment's charge", async () => {
    const seen: unknown[] = [];
    const provider = withIntent(
      { id: "ch_1", payment_method_details: { type: "card", card: { country: "ae" } } },
      seen,
    );
    expect(await provider.getCardCountry("pi_1")).toBe("AE");
    // The charge must be expanded, or only its id comes back and no country can be read.
    expect(seen[0]).toEqual([
      "pi_1",
      { expand: ["latest_charge"] },
      { timeout: 5_000, maxNetworkRetries: 0 },
    ]);
  });

  it("says nothing it does not know: no charge, a bare id, or no card", async () => {
    expect(await withIntent(null).getCardCountry("pi_1")).toBeNull();
    expect(await withIntent("ch_1").getCardCountry("pi_1")).toBeNull();
    expect(
      await withIntent({ id: "ch_1", payment_method_details: { type: "link" } }).getCardCountry(
        "pi_1",
      ),
    ).toBeNull();
    expect(
      await withIntent({
        id: "ch_1",
        payment_method_details: { type: "card", card: { country: null } },
      }).getCardCountry("pi_1"),
    ).toBeNull();
  });
});

describe("classifyRefundError", () => {
  const stripeError = (Kind: typeof Stripe.errors.StripeError, raw: Record<string, unknown>) =>
    new Kind({ message: "x", ...raw } as never);

  it("treats connection, server, rate and key-in-use failures as unclear", () => {
    for (const error of [
      stripeError(Stripe.errors.StripeConnectionError, {}),
      stripeError(Stripe.errors.StripeAPIError, { statusCode: 500 }),
      stripeError(Stripe.errors.StripeRateLimitError, { statusCode: 429, code: "rate_limit" }),
      stripeError(Stripe.errors.StripeIdempotencyError, { statusCode: 409 }),
      new Error("anything we do not recognise"),
    ]) {
      expect(classifyRefundError(error)).toBeInstanceOf(RefundUnclearError);
    }
  });

  it("treats a lock timeout or any 409 as unclear, before the 4xx rule", () => {
    for (const raw of [
      { statusCode: 400, code: "lock_timeout" },
      { statusCode: 429, code: "lock_timeout" },
      { statusCode: 409, code: "idempotency_key_in_use" },
      { statusCode: 409 },
    ]) {
      expect(
        classifyRefundError(stripeError(Stripe.errors.StripeInvalidRequestError, raw)),
      ).toBeInstanceOf(RefundUnclearError);
    }
  });

  it("treats a 4xx with a code as a clear refusal", () => {
    const refused = classifyRefundError(
      stripeError(Stripe.errors.StripeInvalidRequestError, {
        statusCode: 400,
        code: "resource_missing",
      }),
    );
    expect(refused).toBeInstanceOf(RefundRefusedError);
    expect((refused as RefundRefusedError).code).toBe("resource_missing");
    expect((refused as RefundRefusedError).alreadyRefunded).toBe(false);
  });

  it("treats a Stripe error with no status or no code as unclear", () => {
    expect(
      classifyRefundError(stripeError(Stripe.errors.StripeInvalidRequestError, {})),
    ).toBeInstanceOf(RefundUnclearError);
    expect(
      classifyRefundError(
        stripeError(Stripe.errors.StripeInvalidRequestError, { statusCode: 400 }),
      ),
    ).toBeInstanceOf(RefundUnclearError);
  });

  it("never carries Stripe's message, only its code", () => {
    const refused = classifyRefundError(
      stripeError(Stripe.errors.StripeInvalidRequestError, {
        statusCode: 400,
        code: "amount_too_large",
        message: "Refund amount (AED 1299) is greater than charge for amina@example.com",
      }),
    );
    expect((refused as Error).message).not.toMatch(/amina/);
  });
});

describe("refundStatusOf", () => {
  it("keeps the statuses we act on", () => {
    expect(refundStatusOf("succeeded")).toBe("succeeded");
    expect(refundStatusOf("failed")).toBe("failed");
    expect(refundStatusOf("canceled")).toBe("canceled");
    expect(refundStatusOf("pending")).toBe("pending");
  });

  // An unknown or missing status must never become an insert that fails and is retried for days.
  it("reads anything else as still in flight", () => {
    expect(refundStatusOf("requires_action")).toBe("pending");
    expect(refundStatusOf("something_new")).toBe("pending");
    expect(refundStatusOf(null)).toBe("pending");
  });
});

describe("toPaymentEvent for refunds", () => {
  const refundEvent = (type: string, object: Record<string, unknown> = {}) =>
    ({
      id: "evt_r",
      created: 1800000000,
      type,
      data: {
        object: {
          id: "re_1",
          object: "refund",
          amount: 129900,
          currency: "aed",
          status: "succeeded",
          payment_intent: "pi_1",
          metadata: { orderId: "order-1", refundId: "row-1" },
          ...object,
        },
      },
    }) as unknown as Stripe.Event;

  it.each(["refund.created", "refund.updated", "refund.failed"])(
    "reduces %s to a refund event",
    (type) => {
      const reduced = toPaymentEvent(refundEvent(type)) as RefundEvent;
      expect(reduced).toEqual({
        kind: "refund",
        eventId: "evt_r",
        type,
        occurredAt: new Date(1800000000 * 1000),
        ignorable: false,
        orderId: "order-1",
        refundRowId: "row-1",
        providerRefundId: "re_1",
        paymentIntentId: "pi_1",
        amountFils: 129900,
        currency: "AED",
        status: "succeeded",
      });
    },
  );

  // A refund made in the dashboard carries none of our metadata.
  it("leaves our ids null for a refund made elsewhere", () => {
    const reduced = toPaymentEvent(refundEvent("refund.created", { metadata: {} })) as RefundEvent;
    expect(reduced.orderId).toBeNull();
    expect(reduced.refundRowId).toBeNull();
  });

  it("reads the payment intent whether it is an id, an object or absent", () => {
    const expanded = toPaymentEvent(
      refundEvent("refund.updated", { payment_intent: { id: "pi_obj" } }),
    ) as RefundEvent;
    expect(expanded.paymentIntentId).toBe("pi_obj");
    const none = toPaymentEvent(
      refundEvent("refund.updated", { payment_intent: null }),
    ) as RefundEvent;
    expect(none.paymentIntentId).toBeNull();
  });

  it("does not mistake a refund event for a checkout one", () => {
    expect(toPaymentEvent(refundEvent("refund.created")).kind).toBe("refund");
  });
});
