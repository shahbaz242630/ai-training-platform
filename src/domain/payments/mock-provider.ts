import { createHmac, timingSafeEqual } from "node:crypto";
import {
  InvalidSignatureError,
  type IssuedRefund,
  type PaymentEvent,
  type PaymentOutcome,
  type PaymentProvider,
  type RefundPaymentInput,
  type RefundSnapshot,
  type RefundStatus,
  type StartCheckoutInput,
  type StartedCheckout,
} from "./provider";

/**
 * A payment provider that takes no money.
 *
 * This exists so the entire booking flow - checkout, webhook, confirmation -
 * can be built and tested before any Stripe credential exists, and so CI can
 * run the whole path with no account, no key and no network. It is the only
 * implementation that can.
 *
 * It is a REAL implementation of the contract, not a stub that agrees with
 * whatever the caller expected. In particular it genuinely signs and verifies:
 * a webhook test that accepts any signature proves nothing about the code
 * that must reject a forged one.
 */

const DEFAULT_SECRET = "mock-webhook-secret";

let refundCounter = 0;

interface RecordedCheckout {
  readonly input: StartCheckoutInput;
  readonly checkoutSessionId: string;
}

export class MockPaymentProvider implements PaymentProvider {
  private readonly secret: string;
  private counter = 0;

  /** Every checkout started, so a test can assert what was sent to the processor. */
  readonly started: RecordedCheckout[] = [];

  /*
    Keyed by idempotency key. A repeated key returns the ORIGINAL session
    rather than a new one, because that is what the real processor does and a
    mock that quietly creates a second checkout would hide a double-charge bug
    rather than surface it.
  */
  private readonly byIdempotencyKey = new Map<string, StartedCheckout>();

  /** Every session it was asked to end, in order. */
  readonly expired: string[] = [];

  /** Every refund request that reached the processor, repeats included. */
  readonly refundRequests: RefundPaymentInput[] = [];

  /*
    Refunds by idempotency key, for the same reason as checkouts: a repeated
    key returns the refund already made. A mock that made a second one would
    hide exactly the bug the key exists to prevent.
  */
  private readonly refundsByKey = new Map<string, IssuedRefund>();
  private readonly refunds = new Map<string, RefundSnapshot>();

  /** Failures to answer the next refund requests with, in order. */
  readonly refundFailures: Error[] = [];

  /** The status a newly made refund starts in. */
  refundStatus: RefundStatus = "pending";

  /**
   * The card country each payment reports. A payment not listed reports the
   * UK, so the tests written before the country was asked keep the automatic
   * path they describe; `cardCountryFailure` makes the next question fail.
   */
  readonly cardCountries = new Map<string, string | null>();
  cardCountryFailure: Error | null = null;
  /** Every payment whose card country was asked for. */
  readonly cardCountryRequests: string[] = [];

  constructor(secret: string = DEFAULT_SECRET) {
    this.secret = secret;
  }

  refundPayment(input: RefundPaymentInput): Promise<IssuedRefund> {
    this.refundRequests.push(input);
    const failure = this.refundFailures.shift();
    if (failure) return Promise.reject(failure);

    const seen = this.refundsByKey.get(input.idempotencyKey);
    if (seen) return Promise.resolve(seen);

    // Shared by every instance: a real processor never hands out the same refund id twice.
    refundCounter += 1;
    const issued: IssuedRefund = {
      providerRefundId: `re_mock_${refundCounter}`,
      status: this.refundStatus,
    };
    this.refundsByKey.set(input.idempotencyKey, issued);
    this.refunds.set(issued.providerRefundId, {
      ...issued,
      amountFils: input.amountFils,
      currency: "AED",
      paymentIntentId: input.paymentIntentId,
    });
    return Promise.resolve(issued);
  }

  /** Move a refund on, as the processor would some time after making it. */
  settleRefund(providerRefundId: string, status: RefundStatus): void {
    const refund = this.refunds.get(providerRefundId);
    if (refund) this.refunds.set(providerRefundId, { ...refund, status });
  }

  getRefund(providerRefundId: string): Promise<RefundSnapshot> {
    const refund = this.refunds.get(providerRefundId);
    if (!refund) return Promise.reject(new Error(`no such refund ${providerRefundId}`));
    return Promise.resolve(refund);
  }

  getCardCountry(paymentIntentId: string): Promise<string | null> {
    this.cardCountryRequests.push(paymentIntentId);
    const failure = this.cardCountryFailure;
    if (failure) {
      this.cardCountryFailure = null;
      return Promise.reject(failure);
    }
    const country = this.cardCountries.get(paymentIntentId);
    return Promise.resolve(country === undefined ? "GB" : country);
  }

  expireCheckout(checkoutSessionId: string): Promise<void> {
    this.expired.push(checkoutSessionId);
    return Promise.resolve();
  }

  startCheckout(input: StartCheckoutInput): Promise<StartedCheckout> {
    const seen = this.byIdempotencyKey.get(input.idempotencyKey);
    if (seen) return Promise.resolve(seen);

    this.counter += 1;
    const checkoutSessionId = `cs_mock_${this.counter}`;
    const result: StartedCheckout = {
      checkoutSessionId,
      redirectUrl: `https://checkout.invalid/pay/${checkoutSessionId}`,
    };

    this.started.push({ input, checkoutSessionId });
    this.byIdempotencyKey.set(input.idempotencyKey, result);
    return Promise.resolve(result);
  }

  /**
   * Sign a body the way the real processor would, so tests can produce a
   * delivery that genuinely verifies - and, by changing one byte, one that
   * genuinely does not.
   */
  sign(rawBody: string): string {
    return createHmac("sha256", this.secret).update(rawBody).digest("hex");
  }

  /*
    `async`, so a verification failure REJECTS rather than throwing
    synchronously. A method declared to return a promise that throws before
    returning one is a trap: a caller writing `.catch()` around it gets an
    uncaught exception instead. The real adapter is async, and a mock that
    fails differently from the thing it stands in for is worse than no mock.
  */
  async verifyEvent(rawBody: string, signatureHeader: string | null): Promise<PaymentEvent> {
    if (signatureHeader === null) throw new InvalidSignatureError("No signature header was sent");

    const expected = Buffer.from(this.sign(rawBody), "utf8");
    const presented = Buffer.from(signatureHeader, "utf8");
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      throw new InvalidSignatureError();
    }

    return parseMockEvent(rawBody);
  }
}

/** The shape a test writes to describe a delivery. Mirrors what the real adapter reduces to. */
export interface MockEventBody {
  readonly id: string;
  readonly type: string;
  readonly checkoutSessionId?: string;
  /** The payment behind the session, once paid. What a refund would name. */
  readonly paymentIntentId?: string;
  readonly orderId?: string;
  readonly slotHoldId?: string;
  /**
   * The processor reports payment status separately from the event name, and
   * so does this. A completed checkout that is still unpaid is the case worth
   * being able to reproduce.
   */
  readonly paymentStatus?: "paid" | "unpaid" | "no_payment_required";
  readonly amountFils?: number;
  readonly currency?: string;
  readonly createdAtIso?: string;
  /** Refund events only: the refund, and our row id when we made it. */
  readonly providerRefundId?: string;
  readonly refundRowId?: string;
  readonly refundStatus?: RefundStatus;
}

const REFUND_TYPES = new Set(["refund.created", "refund.updated", "refund.failed"]);

const HANDLED = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);

/** Build a signable body for a test, so nothing has to hand-assemble JSON. */
export function mockEventBody(body: MockEventBody): string {
  return JSON.stringify(body);
}

function parseMockEvent(rawBody: string): PaymentEvent {
  const body = JSON.parse(rawBody) as MockEventBody;
  const occurredAt = body.createdAtIso ? new Date(body.createdAtIso) : new Date(0);

  if (REFUND_TYPES.has(body.type)) {
    return {
      kind: "refund",
      eventId: body.id,
      type: body.type,
      occurredAt,
      ignorable: false,
      orderId: body.orderId ?? null,
      refundRowId: body.refundRowId ?? null,
      providerRefundId: body.providerRefundId ?? "re_mock",
      paymentIntentId: body.paymentIntentId ?? null,
      amountFils: body.amountFils ?? 0,
      currency: (body.currency ?? "AED").toUpperCase(),
      status: body.refundStatus ?? "pending",
    };
  }

  const ignorable = !HANDLED.has(body.type);
  return {
    kind: "checkout",
    eventId: body.id,
    type: body.type,
    checkoutSessionId: ignorable ? null : (body.checkoutSessionId ?? null),
    paymentIntentId: ignorable ? null : (body.paymentIntentId ?? null),
    orderId: ignorable ? null : (body.orderId ?? null),
    slotHoldId: ignorable ? null : (body.slotHoldId ?? null),
    outcome: ignorable ? "unpaid" : mockOutcome(body),
    amountFils: ignorable ? null : (body.amountFils ?? null),
    currency: ignorable ? null : (body.currency ?? null),
    occurredAt,
    ignorable,
  };
}

/*
  Deliberately the same rule as the real adapter: the event name decides
  failure, and payment status decides success. If these two drift, the tests
  stop describing production - so the rule is written once in each place and
  asserted against the same cases.
*/
function mockOutcome(body: MockEventBody): PaymentOutcome {
  if (body.type === "checkout.session.async_payment_failed") return "failed";
  if (body.type === "checkout.session.expired") return "failed";
  if (body.paymentStatus === "paid" || body.paymentStatus === "no_payment_required") return "paid";
  return "unpaid";
}
