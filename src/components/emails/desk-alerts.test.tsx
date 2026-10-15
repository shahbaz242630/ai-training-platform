import { describe, expect, it } from "vitest";
import { refundAlertReason, renderRefundNeedsAttention } from "./desk-alerts";
import type { RefundNeedingAttention } from "@/data/refund-queries";

/**
 * The email that tells the booking desk a refund needs a person. Internal,
 * plain, and free of anything about the customer: the booking reference and
 * the payment id are enough to find everything else in Stripe.
 */

const refund: RefundNeedingAttention = {
  refundId: "00000000-0000-4000-8000-000000000001",
  bookingReference: "3F9A1C2B",
  amountFils: 149_900,
  currency: "AED",
  status: "failed",
  lastError: "charge_already_refunded",
  paymentIntentId: "pi_3Desk",
};

describe("renderRefundNeedsAttention", () => {
  it("names the booking and the amount in the subject", async () => {
    const email = await renderRefundNeedsAttention(refund, false);
    expect(email.subject).toBe("Refund needs you: booking 3F9A1C2B, AED 1,499");
  });

  it("marks a reminder as one", async () => {
    const email = await renderRefundNeedsAttention(refund, true);
    expect(email.subject).toBe("Reminder: Refund needs you: booking 3F9A1C2B, AED 1,499");
  });

  it("says what happened, what to do, and which payment to look at", async () => {
    const email = await renderRefundNeedsAttention(refund, false);
    expect(email.text).toContain("already been refunded");
    expect(email.text).toContain(
      "Check the payment in Stripe and refund it by hand if it has not been refunded.",
    );
    expect(email.text).toContain("This alert stops by itself once the refund is recorded.");
    expect(email.text).toContain("pi_3Desk");
    expect(email.text).toContain("search for it in Stripe");
  });

  it("carries nothing about the customer and no long dashes", async () => {
    const email = await renderRefundNeedsAttention(refund, false);
    for (const part of [email.subject, email.text, email.html]) {
      expect(part).not.toMatch(/Amina|Khan|@example\.com/);
      expect(part).not.toMatch(/[–—]/);
    }
  });

  it("still makes sense without a booking reference or a payment id", async () => {
    const email = await renderRefundNeedsAttention(
      { ...refund, bookingReference: null, paymentIntentId: null },
      false,
    );
    expect(email.subject).toBe("Refund needs you: booking unknown, AED 1,499");
    expect(email.text).toContain("no payment on record");
  });
});

describe("refundAlertReason", () => {
  const reason = (status: RefundNeedingAttention["status"], lastError: string | null) =>
    refundAlertReason({ ...refund, status, lastError });

  it("reads each situation in plain words", () => {
    expect(reason("failed", "charge_already_refunded")).toMatch(/already been refunded/);
    expect(reason("failed", "amount_too_large")).toMatch(/already been refunded/);
    expect(reason("failed", "key_window_passed")).toMatch(/could not get a clear answer/);
    expect(reason("failed", "no_payment_intent")).toMatch(/no payment on record/);
    expect(reason("failed", "order_partially_refunded")).toMatch(/partly refunded/);
    expect(reason("failed", "order_not_paid")).toMatch(/not marked as paid/);
    expect(reason("failed", null)).toMatch(/card issuer/);
    expect(reason("failed", "resource_missing")).toMatch(/resource_missing/);
    expect(reason("canceled", null)).toMatch(/cancelled/);
    expect(reason("due", "timeout")).toBe(
      "The refund has not gone through for over a day (last code: timeout).",
    );
    expect(reason("issuing", null)).toBe("The refund has not gone through for over a day.");
    // Nothing claims the payment provider was contacted: it may never have been.
    expect(reason("due", null)).not.toMatch(/provider|reached/);
    expect(reason("pending", null)).toMatch(/pending in Stripe for over 3 days/);
  });
});
