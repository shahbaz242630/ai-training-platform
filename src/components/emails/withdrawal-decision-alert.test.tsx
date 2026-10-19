import { describe, expect, it } from "vitest";
import { renderWithdrawalDecision } from "./withdrawal-decision-alert";
import type { WithdrawalForDesk } from "@/data/withdrawals";

/**
 * The desk alert for a withdrawal a person decides. Internal and plain: what
 * is needed to find the payment and decide, how to approve and how to
 * decline, and nothing about the customer.
 */

const alert: WithdrawalForDesk = {
  bookingId: "3f9a1c2b-0000-4000-8000-000000000001",
  sessionSlug: "claude-claude-code",
  scheduledStart: new Date("2026-11-20T11:00:00Z"),
  receivedAt: new Date("2026-10-19T08:30:00Z"),
  cardCountry: "AE",
  amountFils: 149_900,
  paymentIntentId: "pi_3Desk",
};

const LINK = "https://example.test/training/book/desk-decision?t=d1.abc";

describe("renderWithdrawalDecision", () => {
  it("carries the link that records a decline, when there is one", async () => {
    const withLink = await renderWithdrawalDecision(alert, false, LINK);
    expect(withLink.text).toContain("Then record the decline here, which stops this alert:");
    expect(withLink.text).toContain(LINK);
    const without = await renderWithdrawalDecision(alert, false, null);
    expect(without.text).not.toContain("record the decline here");
  });

  it("names the booking, the amount and the card's country in the subject", async () => {
    const email = await renderWithdrawalDecision(alert, false, null);
    expect(email.subject).toBe("Withdrawal to decide: booking 3F9A1C2B, AED 1,499, card AE");
  });

  it("marks a reminder as one", async () => {
    const email = await renderWithdrawalDecision(alert, true, null);
    expect(email.subject).toMatch(/^Reminder: Withdrawal to decide/);
    expect(email.text).toMatch(/still needs you/i);
  });

  it("says what happened, and how to approve and how to decline", async () => {
    const { text } = await renderWithdrawalDecision(alert, false, null);
    expect(text).toContain("the card they paid with was issued in AE");
    expect(text).toContain("Nothing has been refunded and the booking is still in place.");
    expect(text).toContain("within 3 working days");
    expect(text).toContain("pi_3Desk");
    expect(text).toContain("To approve");
    expect(text).toContain("refund the payment in full in Stripe");
    expect(text).toContain("the customer is emailed that it is cancelled and refunded");
    expect(text).toContain("To decline");
    expect(text).toContain("Do nothing in Stripe.");
    // Fourteen days from the notice, in Dubai time.
    expect(text).toMatch(/Refund due by, if approved:.*2 November 2026/);
  });

  it("says so when the card's country could not be read", async () => {
    const email = await renderWithdrawalDecision({ ...alert, cardCountry: null }, false, null);
    expect(email.subject).toContain("card could not be read");
    expect(email.text).toContain("could not be read");
  });

  it("carries nothing about the customer and no long dashes", async () => {
    const { text, html } = await renderWithdrawalDecision(alert, false, null);
    expect(text).not.toMatch(/@example|Amina/);
    expect(text + html).not.toMatch(/[–—]/);
  });
});
