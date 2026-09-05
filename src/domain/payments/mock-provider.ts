import { createHmac, timingSafeEqual } from "node:crypto";
import {
  InvalidSignatureError,
  type PaymentEvent,
  type PaymentOutcome,
  type PaymentProvider,
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

  constructor(secret: string = DEFAULT_SECRET) {
    this.secret = secret;
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
}

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

  const ignorable = !HANDLED.has(body.type);
  return {
    eventId: body.id,
    type: body.type,
    checkoutSessionId: ignorable ? null : (body.checkoutSessionId ?? null),
    paymentIntentId: ignorable ? null : (body.paymentIntentId ?? null),
    orderId: ignorable ? null : (body.orderId ?? null),
    slotHoldId: ignorable ? null : (body.slotHoldId ?? null),
    outcome: ignorable ? "unpaid" : mockOutcome(body),
    amountFils: ignorable ? null : (body.amountFils ?? null),
    currency: ignorable ? null : (body.currency ?? null),
    occurredAt: body.createdAtIso ? new Date(body.createdAtIso) : new Date(0),
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
