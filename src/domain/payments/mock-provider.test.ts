import { describe, it, expect } from "vitest";
import { MockPaymentProvider, mockEventBody } from "./mock-provider";
import { InvalidSignatureError, type StartCheckoutInput } from "./provider";
import { AED } from "@/lib/money";

/**
 * The provider CI can actually run.
 *
 * It has to be a real implementation of the contract rather than a stub that
 * agrees with the caller, because the things being proven here - a forged
 * signature is rejected, a retry does not create a second charge - are
 * worthless if the mock simply says yes.
 */

const input = (overrides: Partial<StartCheckoutInput> = {}): StartCheckoutInput => ({
  line: { slug: "ai-foundations", title: "AI Foundations", amountFils: 129900, currency: AED },
  orderId: "order-1",
  customerEmail: "amina@example.com",
  slotHoldId: "hold-1",
  successUrl: "https://example.com/ok",
  cancelUrl: "https://example.com/cancel",
  idempotencyKey: "order-1",
  ...overrides,
});

describe("MockPaymentProvider.startCheckout", () => {
  it("starts a checkout and hands back somewhere to send the customer", async () => {
    const provider = new MockPaymentProvider();
    const started = await provider.startCheckout(input());

    expect(started.checkoutSessionId).toBeTruthy();
    expect(started.redirectUrl).toContain(started.checkoutSessionId);
  });

  /*
    THE one that matters. A retried create must return the ORIGINAL session.
    A mock that quietly makes a second one would hide a double-charge bug
    instead of surfacing it.
  */
  it("returns the original session when the same idempotency key is reused", async () => {
    const provider = new MockPaymentProvider();
    const first = await provider.startCheckout(input());
    const second = await provider.startCheckout(input());

    expect(second.checkoutSessionId).toBe(first.checkoutSessionId);
    expect(provider.started).toHaveLength(1);
  });

  it("treats a genuinely different order as a different checkout", async () => {
    const provider = new MockPaymentProvider();
    const first = await provider.startCheckout(input());
    const second = await provider.startCheckout(
      input({ orderId: "order-2", idempotencyKey: "order-2" }),
    );

    expect(second.checkoutSessionId).not.toBe(first.checkoutSessionId);
  });

  it("records what was sent, so a test can assert the amount was never recalculated", async () => {
    const provider = new MockPaymentProvider();
    await provider.startCheckout(input());

    expect(provider.started[0]?.input.line.amountFils).toBe(129900);
    expect(provider.started[0]?.input.line.currency).toBe("AED");
  });
});

describe("MockPaymentProvider.verifyEvent", () => {
  const paid = mockEventBody({
    id: "evt_1",
    type: "checkout.session.completed",
    checkoutSessionId: "cs_1",
    orderId: "order-1",
    slotHoldId: "hold-1",
    paymentStatus: "paid",
    amountFils: 129900,
    currency: "aed",
    createdAtIso: "2027-01-01T00:00:00Z",
  });

  it("accepts a correctly signed delivery", async () => {
    const provider = new MockPaymentProvider();
    const event = await provider.verifyEvent(paid, provider.sign(paid));

    expect(event.outcome).toBe("paid");
    expect(event.orderId).toBe("order-1");
    expect(event.slotHoldId).toBe("hold-1");
    expect(event.ignorable).toBe(false);
  });

  it("refuses a delivery with no signature at all", async () => {
    const provider = new MockPaymentProvider();
    await expect(provider.verifyEvent(paid, null)).rejects.toThrow(InvalidSignatureError);
  });

  it("refuses a forged signature", async () => {
    const provider = new MockPaymentProvider();
    await expect(provider.verifyEvent(paid, "0".repeat(64))).rejects.toThrow(InvalidSignatureError);
  });

  /*
    A signature covers exact bytes. Changing the body after signing must fail,
    or the signature is decoration rather than a control.
  */
  it("refuses a body that was altered after it was signed", async () => {
    const provider = new MockPaymentProvider();
    const signature = provider.sign(paid);
    const tampered = paid.replace("129900", "1");

    await expect(provider.verifyEvent(tampered, signature)).rejects.toThrow(InvalidSignatureError);
  });

  it("refuses a signature made with a different secret", async () => {
    const provider = new MockPaymentProvider("the-real-secret");
    const impostor = new MockPaymentProvider("a-guess");

    await expect(provider.verifyEvent(paid, impostor.sign(paid))).rejects.toThrow(
      InvalidSignatureError,
    );
  });

  /*
    THE delayed-payment trap. A completed checkout can still be unpaid: the
    money may arrive hours later, or never. Reading the event NAME as success
    is how somebody gets a confirmed session for a payment that bounces.
  */
  it("reports a completed but unpaid checkout as unpaid, not paid", async () => {
    const provider = new MockPaymentProvider();
    const body = mockEventBody({
      id: "evt_2",
      type: "checkout.session.completed",
      orderId: "order-2",
      paymentStatus: "unpaid",
    });

    const event = await provider.verifyEvent(body, provider.sign(body));
    expect(event.outcome).toBe("unpaid");
  });

  it("reports the later async success as paid", async () => {
    const provider = new MockPaymentProvider();
    const body = mockEventBody({
      id: "evt_3",
      type: "checkout.session.async_payment_succeeded",
      orderId: "order-2",
      paymentStatus: "paid",
    });

    const event = await provider.verifyEvent(body, provider.sign(body));
    expect(event.outcome).toBe("paid");
  });

  it("reports an async failure and an expiry as failed", async () => {
    const provider = new MockPaymentProvider();
    for (const type of ["checkout.session.async_payment_failed", "checkout.session.expired"]) {
      const body = mockEventBody({ id: `evt_${type}`, type, orderId: "order-2" });
      const event = await provider.verifyEvent(body, provider.sign(body));
      expect(event.outcome).toBe("failed");
    }
  });

  /*
    A processor sends far more event types than we consume. An unrecognised
    one must be ignorable rather than an error - a handler that treats it as a
    failure returns 500 and gets retried forever.
  */
  it("marks an event type we do not consume as ignorable rather than failing", async () => {
    const provider = new MockPaymentProvider();
    const body = mockEventBody({ id: "evt_9", type: "customer.subscription.updated" });

    const event = await provider.verifyEvent(body, provider.sign(body));
    expect(event.ignorable).toBe(true);
    expect(event.orderId).toBeNull();
  });
});
