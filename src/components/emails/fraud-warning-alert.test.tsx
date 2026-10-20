import { describe, expect, it } from "vitest";
import type { FraudWarningForDesk } from "@/data/fraud-warnings";
import { renderFraudWarning } from "./fraud-warning-alert";

const base: FraudWarningForDesk = {
  id: "11111111-1111-4111-8111-111111111111",
  outcome: "refund_queued",
  fraudType: "made_with_stolen_card",
  receivedAt: new Date("2027-03-01T08:00:00Z"),
  orderId: "22222222-2222-4222-8222-222222222222",
  grossAmountFils: 129900,
  bookingId: "33333333-3333-4333-8333-333333333333",
  sessionSlug: "ai-foundations",
  sessionStart: new Date("2027-03-10T15:00:00Z"),
};

describe("renderFraudWarning", () => {
  it("says an automatic refund was made, and that nobody was emailed", async () => {
    const email = await renderFraudWarning(base, false);
    expect(email.subject).toMatch(/^Stolen card warning, refunded automatically: booking \S+, /);
    expect(email.text).toContain("made with stolen card");
    expect(email.text).toContain("full amount is being refunded");
    expect(email.text).toContain("Nobody was emailed");
    expect(email.text + email.html).not.toMatch(/[–—]/);
  });

  it("asks a person to decide, and says how", async () => {
    const email = await renderFraudWarning({ ...base, outcome: "desk_decides" }, true);
    expect(email.subject).toMatch(/^Reminder: Stolen card warning, needs you: /);
    expect(email.text).toContain("Nothing was done automatically");
    expect(email.text).toContain("refunding in full now usually prevents the chargeback");
  });

  it("handles a payment that is not ours", async () => {
    const email = await renderFraudWarning(
      {
        ...base,
        outcome: "unknown_order",
        orderId: null,
        grossAmountFils: null,
        bookingId: null,
        sessionSlug: null,
        sessionStart: null,
      },
      false,
    );
    expect(email.subject).toContain("booking unknown, amount unknown");
    expect(email.text).toContain("No booking of ours has this payment");
  });
});
