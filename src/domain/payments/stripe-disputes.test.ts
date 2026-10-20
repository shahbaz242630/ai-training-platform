import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { DisputeReadError } from "./provider";
import { classifyDisputeReadError } from "./stripe-disputes";
import { StripePaymentProvider } from "./stripe-provider";

/**
 * Reading a dispute through the REAL adapter, and sorting a failed read. The
 * sort decides what the webhook does: a read worth trying again fails the
 * delivery so Stripe sends it again; a clear refusal stores the event's own
 * copy, because three days of retries would store nothing and tell nobody.
 */

const SIGNING_SECRET = "whsec_test_secret_for_verification_only";

const stripeError = (Kind: typeof Stripe.errors.StripeError, raw: Record<string, unknown>) =>
  new Kind({ message: "x", ...raw } as never);

describe("classifyDisputeReadError", () => {
  it("treats no answer, Stripe failing, a rate limit and a conflict as worth trying again", () => {
    for (const error of [
      new Error("not a Stripe error at all"),
      stripeError(Stripe.errors.StripeConnectionError, {}),
      stripeError(Stripe.errors.StripeAPIError, { statusCode: 500 }),
      stripeError(Stripe.errors.StripeRateLimitError, { statusCode: 429, code: "rate_limit" }),
      stripeError(Stripe.errors.StripeInvalidRequestError, {
        statusCode: 409,
        code: "lock_timeout",
      }),
      stripeError(Stripe.errors.StripeInvalidRequestError, { statusCode: 503 }),
    ]) {
      expect(classifyDisputeReadError(error).transient).toBe(true);
    }
  });

  it("treats a clear refusal as final, keeping only its code", () => {
    const missing = classifyDisputeReadError(
      stripeError(Stripe.errors.StripeInvalidRequestError, {
        statusCode: 404,
        code: "resource_missing",
      }),
    );
    expect(missing).toMatchObject({ transient: false, code: "resource_missing" });

    const forbidden = classifyDisputeReadError(
      stripeError(Stripe.errors.StripePermissionError, { statusCode: 403 }),
    );
    expect(forbidden).toMatchObject({ transient: false, code: "http_403" });
  });
});

describe("getDispute", () => {
  it("reads the dispute with a time limit", async () => {
    let seenOptions: Stripe.RequestOptions | undefined;
    const disputes = {
      retrieve: (_id: string, _params: unknown, options: Stripe.RequestOptions) => {
        seenOptions = options;
        return Promise.resolve({
          id: "dp_live",
          amount: 129900,
          currency: "aed",
          reason: "fraudulent",
          status: "under_review",
          payment_intent: "pi_live",
          evidence_details: { due_by: null },
        });
      },
    };
    const provider = new StripePaymentProvider({ disputes } as unknown as Stripe, SIGNING_SECRET);

    const snapshot = await provider.getDispute("dp_live");

    expect(snapshot).toMatchObject({ status: "under_review", paymentIntentId: "pi_live" });
    expect(seenOptions?.timeout).toBeGreaterThan(0);
  });

  it("sorts a failed read before it leaves the adapter", async () => {
    const disputes = {
      retrieve: () =>
        Promise.reject(
          stripeError(Stripe.errors.StripeInvalidRequestError, {
            statusCode: 404,
            code: "resource_missing",
          }),
        ),
    };
    const provider = new StripePaymentProvider({ disputes } as unknown as Stripe, SIGNING_SECRET);

    const failure = await provider.getDispute("dp_gone").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DisputeReadError);
    expect(failure).toMatchObject({ transient: false, code: "resource_missing" });
  });
});
