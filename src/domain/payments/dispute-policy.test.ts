import type Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { mayReplaceStatus } from "@/data/disputes";
import { disputeCancels, disputeStage } from "./dispute-policy";
import { toDisputeSnapshot } from "./stripe-disputes";
import { toPaymentEvent } from "./stripe-provider";

/**
 * The dispute rules, and the Stripe shapes they read. The statuses are the
 * installed SDK's (API 2026-08-26.dahlia): a status missing from the table
 * would be read as unknown, which blocks moves and tells the desk but never
 * cancels a session.
 */

describe("the stage of a dispute", () => {
  it.each([
    ["warning_needs_response", "inquiry"],
    ["warning_under_review", "inquiry"],
    ["needs_response", "chargeback"],
    ["under_review", "chargeback"],
    ["won", "won"],
    // An inquiry closed after 120 days without escalating: over, in our favour.
    ["warning_closed", "won"],
    ["lost", "money_gone"],
    // Resolved before a chargeback, usually by giving the cardholder the money back.
    ["prevented", "money_gone"],
    ["something_new", "unknown"],
  ])("%s is %s", (status, stage) => {
    expect(disputeStage(status)).toBe(stage);
  });
});

describe("what a dispute cancels", () => {
  it("a stolen-card chargeback cancels; a stolen-card inquiry does not", () => {
    expect(disputeCancels({ status: "needs_response", reason: "fraudulent" })).toBe("fraud");
    expect(disputeCancels({ status: "under_review", reason: "fraudulent" })).toBe("fraud");
    expect(disputeCancels({ status: "warning_needs_response", reason: "fraudulent" })).toBeNull();
  });

  it("any other chargeback leaves the session: it is the evidence", () => {
    expect(disputeCancels({ status: "needs_response", reason: "product_not_received" })).toBeNull();
    expect(disputeCancels({ status: "needs_response", reason: "unrecognized" })).toBeNull();
  });

  it("money gone cancels, whatever the reason; a win and an unknown status never do", () => {
    expect(disputeCancels({ status: "lost", reason: "product_not_received" })).toBe("money_gone");
    expect(disputeCancels({ status: "prevented", reason: "fraudulent" })).toBe("money_gone");
    expect(disputeCancels({ status: "won", reason: "fraudulent" })).toBeNull();
    expect(disputeCancels({ status: "brand_new", reason: "fraudulent" })).toBeNull();
  });
});

describe("whether a newer read may replace the stored status", () => {
  it("moves forward only", () => {
    expect(mayReplaceStatus("needs_response", "under_review")).toBe(true);
    expect(mayReplaceStatus("under_review", "needs_response")).toBe(false);
    expect(mayReplaceStatus("under_review", "won")).toBe(true);
    expect(mayReplaceStatus("won", "under_review")).toBe(false);
    expect(mayReplaceStatus("needs_response", "needs_response")).toBe(true);
  });

  it("lets a loss turn into a late win, and nothing else leave a result", () => {
    expect(mayReplaceStatus("lost", "won")).toBe(true);
    expect(mayReplaceStatus("won", "lost")).toBe(false);
    expect(mayReplaceStatus("prevented", "won")).toBe(false);
  });

  it("always applies a status it does not know, either way", () => {
    expect(mayReplaceStatus("won", "brand_new")).toBe(true);
    expect(mayReplaceStatus("brand_new", "needs_response")).toBe(true);
  });
});

function stripeDispute(over: Partial<Stripe.Dispute> = {}): Stripe.Dispute {
  return {
    id: "dp_1",
    object: "dispute",
    amount: 129900,
    currency: "aed",
    reason: "fraudulent",
    status: "needs_response",
    payment_intent: "pi_1",
    evidence_details: { due_by: 1_800_000_000 },
    ...over,
  } as unknown as Stripe.Dispute;
}

describe("reading a Stripe dispute", () => {
  it("keeps the payment, the amount in its own currency, the reason, the status and the deadline", () => {
    expect(toDisputeSnapshot(stripeDispute())).toEqual({
      providerDisputeId: "dp_1",
      paymentIntentId: "pi_1",
      amountMinor: 129900,
      currency: "AED",
      reason: "fraudulent",
      status: "needs_response",
      evidenceDueBy: new Date(1_800_000_000 * 1000),
    });
  });

  it("reads the payment whether it comes as an id, the whole object, or not at all", () => {
    const expanded = stripeDispute({
      payment_intent: { id: "pi_obj", object: "payment_intent" } as Stripe.PaymentIntent,
    });
    expect(toDisputeSnapshot(expanded).paymentIntentId).toBe("pi_obj");
    expect(toDisputeSnapshot(stripeDispute({ payment_intent: null })).paymentIntentId).toBeNull();
  });

  // Stripe sends 0 when no response is allowed: that is no deadline, not 1 January 1970.
  it("reads a deadline of 0, or none, as no deadline", () => {
    const zero = stripeDispute({
      evidence_details: { due_by: 0 } as Stripe.Dispute.EvidenceDetails,
    });
    expect(toDisputeSnapshot(zero).evidenceDueBy).toBeNull();
    const none = stripeDispute({
      evidence_details: { due_by: null } as Stripe.Dispute.EvidenceDetails,
    });
    expect(toDisputeSnapshot(none).evidenceDueBy).toBeNull();
  });

  function event(type: string): Stripe.Event {
    return {
      id: "evt_1",
      type,
      created: 1_800_000_000,
      data: { object: stripeDispute() },
    } as unknown as Stripe.Event;
  }

  it.each(["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"])(
    "turns %s into a dispute event naming the dispute, with the copy it carried",
    (type) => {
      expect(toPaymentEvent(event(type))).toEqual({
        kind: "dispute",
        eventId: "evt_1",
        type,
        occurredAt: new Date(1_800_000_000 * 1000),
        ignorable: false,
        providerDisputeId: "dp_1",
        // Used only when the processor clearly refuses to be asked again.
        snapshot: toDisputeSnapshot(stripeDispute()),
      });
    },
  );

  it("ignores the events that follow the money rather than the dispute", () => {
    expect(toPaymentEvent(event("charge.dispute.funds_withdrawn")).ignorable).toBe(true);
    expect(toPaymentEvent(event("charge.dispute.funds_reinstated")).ignorable).toBe(true);
  });
});
