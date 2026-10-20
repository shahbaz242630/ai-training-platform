import { describe, expect, it } from "vitest";
import { renderDatabaseNearFull, renderHoldsNearCap } from "./protection-alert";

describe("renderHoldsNearCap", () => {
  it("says how many holds are live against the cap, and what to check", async () => {
    const email = await renderHoldsNearCap(24, 30, false);
    expect(email.subject).toBe("Unpaid holds are near the booking limit (24 of 30)");
    expect(email.text).toContain("24 unpaid holds are live at once");
    expect(email.text).toContain("35 minutes");
    expect(email.text + email.html).not.toMatch(/[–—]/);
  });

  it("marks a reminder", async () => {
    expect((await renderHoldsNearCap(30, 30, true)).subject).toMatch(/^Reminder: /);
  });
});

describe("renderDatabaseNearFull", () => {
  it("says how full the database is and what stops at the limit", async () => {
    const email = await renderDatabaseNearFull(360, 500, false);
    expect(email.subject).toBe("The booking database is nearly full (360 MB of 500 MB)");
    expect(email.text).toContain("checkout, payment confirmations and every email stop");
    expect(email.text + email.html).not.toMatch(/[–—]/);
  });

  it("marks a reminder", async () => {
    expect((await renderDatabaseNearFull(400, 500, true)).subject).toMatch(/^Reminder: /);
  });
});
