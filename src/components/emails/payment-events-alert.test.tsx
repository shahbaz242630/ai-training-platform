import { describe, expect, it } from "vitest";
import { renderPaymentEventsMissing, renderReconciliationFailing } from "./payment-events-alert";

describe("renderPaymentEventsMissing", () => {
  it("says how many checkouts were finished by asking, and what to check in Stripe", async () => {
    const email = await renderPaymentEventsMissing(2, false);
    expect(email.subject).toBe(
      "Payment notices from Stripe are delayed or missing (2 in the last day)",
    );
    expect(email.text).toContain("2 checkouts were finished by asking Stripe directly");
    expect(email.text).toContain("abandoned checkouts gave their times back");
    expect(email.text).toContain("Workbench, Webhooks");
  });

  it("counts one in the singular, marks a reminder, and has no long dashes", async () => {
    const email = await renderPaymentEventsMissing(1, true);
    expect(email.subject).toMatch(/^Reminder: /);
    expect(email.text).toContain("1 checkout was finished");
    expect(email.text + email.html).not.toMatch(/[–—]/);
  });
});

describe("renderReconciliationFailing", () => {
  it("says the safety net is down and what to check", async () => {
    const email = await renderReconciliationFailing(3, false);
    expect(email.subject).toBe("Checking unfinished payments with Stripe is failing (3 waiting)");
    expect(email.text).toContain("3 unfinished checkouts could not be checked");
    expect(email.text).toContain("Checkout Sessions");
    expect(email.text + email.html).not.toMatch(/[–—]/);
  });

  it("marks a reminder and counts one in the singular", async () => {
    const email = await renderReconciliationFailing(1, true);
    expect(email.subject).toMatch(/^Reminder: /);
    expect(email.text).toContain("1 unfinished checkout could not");
  });
});
