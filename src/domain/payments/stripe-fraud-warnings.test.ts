import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { toPaymentEvent } from "./stripe-provider";

/**
 * Stripe's early fraud warning, reduced to our shape (audit s104 PAY-4).
 * The fields are the installed SDK's (Stripe.Radar.EarlyFraudWarning).
 */

const event = (object: Record<string, unknown>, type = "radar.early_fraud_warning.created") =>
  ({
    id: "evt_1",
    type,
    created: 1_800_000_000,
    data: {
      object: {
        id: "issfr_1",
        object: "radar.early_fraud_warning",
        actionable: true,
        charge: "ch_1",
        created: 1_800_000_000,
        fraud_type: "made_with_stolen_card",
        livemode: false,
        payment_intent: "pi_1",
        ...object,
      },
    },
  }) as unknown as Stripe.Event;

describe("an early fraud warning from Stripe", () => {
  it("names the payment, the category and whether it can still be acted on", () => {
    expect(toPaymentEvent(event({}))).toEqual({
      kind: "fraud_warning",
      eventId: "evt_1",
      type: "radar.early_fraud_warning.created",
      occurredAt: new Date(1_800_000_000 * 1000),
      ignorable: false,
      providerWarningId: "issfr_1",
      paymentIntentId: "pi_1",
      fraudType: "made_with_stolen_card",
      actionable: true,
    });
  });

  it("reads an expanded payment, a missing one, and a long or empty category safely", () => {
    const expanded = toPaymentEvent(event({ payment_intent: { id: "pi_2" }, fraud_type: "" }));
    expect(expanded).toMatchObject({ paymentIntentId: "pi_2", fraudType: "unknown" });
    const bare = toPaymentEvent(event({ payment_intent: undefined, fraud_type: "x".repeat(200) }));
    expect(bare).toMatchObject({ paymentIntentId: null });
    expect(bare.kind === "fraud_warning" && bare.fraudType.length).toBe(60);
  });

  it("treats anything but true as not actionable", () => {
    expect(toPaymentEvent(event({ actionable: "yes" }))).toMatchObject({ actionable: false });
  });

  it("ignores the update event: it only ever turns actionable off", () => {
    expect(toPaymentEvent(event({}, "radar.early_fraud_warning.updated"))).toMatchObject({
      kind: "checkout",
      ignorable: true,
    });
  });
});
