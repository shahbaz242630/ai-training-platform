import { describe, it, expect } from "vitest";
import { AED } from "@/lib/money";
import { createOrder, transitionPayment, OrderShapeError, type Order } from "./order";
import { InvalidTransitionError } from "./transitions";

const NOW = new Date("2026-09-01T10:00:00.000Z");
const LATER = new Date("2026-09-01T10:05:00.000Z");

const singleOrderInput = {
  id: "ord_1",
  customerId: "cus_1",
  orderType: "single" as const,
  sessionSlug: "claude-claude-code",
  grossAmountFils: 149900,
  currency: AED,
  taxRateBasisPoints: 0,
  now: NOW,
};

const anOrder = (overrides: Partial<Order> = {}): Order => ({
  ...createOrder(singleOrderInput),
  ...overrides,
});

describe("createOrder", () => {
  it("builds a single-session order that has not been paid for yet", () => {
    const order = createOrder(singleOrderInput);
    expect(order.paymentStatus).toBe("pending");
    expect(order.sessionSlug).toBe("claude-claude-code");
    expect(order.pathwaySlug).toBeNull();
    expect(order.stripePaymentIntentId).toBeNull();
    expect(order.createdAt).toEqual(NOW);
    expect(order.updatedAt).toEqual(NOW);
  });

  it("records prices as VAT-inclusive, so a displayed figure survives tax registration", () => {
    expect(createOrder(singleOrderInput).taxTreatment).toBe("inclusive");
  });

  it("builds a pathway order", () => {
    const order = createOrder({
      ...singleOrderInput,
      orderType: "pathway",
      sessionSlug: null,
      pathwaySlug: "builder-pathway",
    });
    expect(order.orderType).toBe("pathway");
    expect(order.pathwaySlug).toBe("builder-pathway");
    expect(order.sessionSlug).toBeNull();
  });

  it("refuses a single order with no session", () => {
    expect(() => createOrder({ ...singleOrderInput, sessionSlug: null })).toThrow(OrderShapeError);
  });

  it("refuses a single order that also names a pathway", () => {
    expect(() => createOrder({ ...singleOrderInput, pathwaySlug: "builder-pathway" })).toThrow(
      OrderShapeError,
    );
  });

  it("refuses a pathway order with no pathway", () => {
    expect(() =>
      createOrder({ ...singleOrderInput, orderType: "pathway", sessionSlug: null }),
    ).toThrow(OrderShapeError);
  });

  it("refuses a pathway order that also names a session", () => {
    expect(() =>
      createOrder({ ...singleOrderInput, orderType: "pathway", pathwaySlug: "builder-pathway" }),
    ).toThrow(OrderShapeError);
  });

  it("refuses a free or negative amount", () => {
    expect(() => createOrder({ ...singleOrderInput, grossAmountFils: 0 })).toThrow(OrderShapeError);
    expect(() => createOrder({ ...singleOrderInput, grossAmountFils: -100 })).toThrow(
      OrderShapeError,
    );
  });

  it("refuses a fractional amount, because fils is already the smallest unit", () => {
    expect(() => createOrder({ ...singleOrderInput, grossAmountFils: 1299.5 })).toThrow(
      OrderShapeError,
    );
  });
});

describe("transitionPayment", () => {
  it("moves a pending order to paid and records the payment intent", () => {
    const result = transitionPayment(anOrder(), "paid", LATER, {
      stripePaymentIntentId: "pi_123",
    });
    expect(result.changed).toBe(true);
    expect(result.entity.paymentStatus).toBe("paid");
    expect(result.entity.stripePaymentIntentId).toBe("pi_123");
    expect(result.entity.updatedAt).toEqual(LATER);
  });

  it("is a no-op when the order is already in the target state", () => {
    // Stripe retries webhook deliveries. A duplicate must not be an error and
    // must not produce a second side effect.
    const paid = anOrder({ paymentStatus: "paid" });
    const result = transitionPayment(paid, "paid", LATER);
    expect(result.changed).toBe(false);
    expect(result.entity).toBe(paid);
  });

  it("never mutates the order it was given", () => {
    const order = anOrder();
    transitionPayment(order, "paid", LATER);
    expect(order.paymentStatus).toBe("pending");
  });

  it("keeps the existing payment intent when the caller supplies none", () => {
    const paid = anOrder({ paymentStatus: "paid", stripePaymentIntentId: "pi_original" });
    const result = transitionPayment(paid, "refunded", LATER);
    expect(result.entity.stripePaymentIntentId).toBe("pi_original");
  });

  it("allows a declined attempt to be followed by a successful one", () => {
    const failed = anOrder({ paymentStatus: "failed" });
    expect(transitionPayment(failed, "paid", LATER).entity.paymentStatus).toBe("paid");
  });

  it("allows a full and a partial refund from paid", () => {
    const paid = anOrder({ paymentStatus: "paid" });
    expect(transitionPayment(paid, "refunded", LATER).entity.paymentStatus).toBe("refunded");
    expect(transitionPayment(paid, "partially_refunded", LATER).entity.paymentStatus).toBe(
      "partially_refunded",
    );
  });

  it("allows a partial refund to become a full one", () => {
    const partial = anOrder({ paymentStatus: "partially_refunded" });
    expect(transitionPayment(partial, "refunded", LATER).entity.paymentStatus).toBe("refunded");
  });

  it("refuses to refund an order that was never paid", () => {
    expect(() => transitionPayment(anOrder(), "refunded", LATER)).toThrow(InvalidTransitionError);
  });

  it("refuses to move a paid order back to pending", () => {
    const paid = anOrder({ paymentStatus: "paid" });
    expect(() => transitionPayment(paid, "pending", LATER)).toThrow(InvalidTransitionError);
  });

  it("refuses to move a refunded order anywhere at all", () => {
    const refunded = anOrder({ paymentStatus: "refunded" });
    expect(() => transitionPayment(refunded, "paid", LATER)).toThrow(InvalidTransitionError);
    expect(() => transitionPayment(refunded, "partially_refunded", LATER)).toThrow(
      InvalidTransitionError,
    );
  });

  it("refuses to fail an order that already succeeded", () => {
    const paid = anOrder({ paymentStatus: "paid" });
    expect(() => transitionPayment(paid, "failed", LATER)).toThrow(InvalidTransitionError);
  });
});
