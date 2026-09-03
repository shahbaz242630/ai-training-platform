import { describe, expect, it } from "vitest";
import {
  TemplateNotAvailableError,
  containsPlaceholder,
  renderTemplate,
  type SessionEmailModel,
} from "./templates";

/**
 * What a customer would actually read. These assert the facts every message
 * must carry - which session, when, in whose time zone - and that nothing a
 * template promises is missing from the model it was rendered from.
 */

const model: SessionEmailModel = {
  firstName: "Amina",
  sessionTitle: "Claude, Claude Code & Advanced Workflows",
  durationMinutes: 90,
  // 18:00 in Dubai, which is 15:00 in London that day (BST).
  slot: { start: new Date("2026-09-12T14:00:00Z"), end: new Date("2026-09-12T15:30:00Z") },
  timeZone: "Europe/London",
  joinUrl: "https://teams.microsoft.com/l/meetup-join/example",
  nextSessionTitle: "AI Agents & Autonomous Workflows",
};

describe("renderTemplate", () => {
  it("renders the payment acknowledgement with the session, the date and the time in the customer's zone", async () => {
    const email = await renderTemplate("payment_receipt", model);

    expect(email.subject).toBe(
      "Payment received: Claude, Claude Code & Advanced Workflows, Saturday, 12 September 2026",
    );
    // Headings come out of the plain-text renderer in capitals.
    expect(email.text).toMatch(/THANK YOU, AMINA/);
    expect(email.html).toContain("Amina");
    expect(email.text).toContain("15:00 - 16:30 (Europe/London)");
    expect(email.text).toContain("18:00 GST");
    expect(email.text).toContain("follow by email");
    expect(email.html).toContain("<table");
    // Nothing to click yet, and it must not pretend otherwise.
    expect(email.text).not.toContain("teams.microsoft.com");
  });

  it("renders the confirmation with the joining link in both bodies", async () => {
    const email = await renderTemplate("booking_confirmation", model);

    expect(email.subject).toBe(
      "Booked: Claude, Claude Code & Advanced Workflows, Saturday, 12 September 2026 at 15:00 - 16:30",
    );
    expect(email.html).toContain('href="https://teams.microsoft.com/l/meetup-join/example"');
    expect(email.text).toContain("https://teams.microsoft.com/l/meetup-join/example");
    expect(email.text).toContain("90 minutes");
  });

  it("refuses to render a confirmation or a reminder without a joining link", async () => {
    const withoutLink = { ...model, joinUrl: null };
    for (const key of ["booking_confirmation", "reminder_24h", "reminder_3h"] as const) {
      await expect(renderTemplate(key, withoutLink)).rejects.toThrow(TemplateNotAvailableError);
      await expect(renderTemplate(key, withoutLink)).rejects.toThrow(/no joining link/);
    }
  });

  it("renders the two reminders as the same message at different distances", async () => {
    const day = await renderTemplate("reminder_24h", model);
    const soon = await renderTemplate("reminder_3h", model);

    expect(day.subject).toBe("Tomorrow: Claude, Claude Code & Advanced Workflows at 15:00 - 16:30");
    expect(soon.subject).toBe(
      "In three hours: Claude, Claude Code & Advanced Workflows at 15:00 - 16:30",
    );
    expect(day.text).toContain("https://teams.microsoft.com/l/meetup-join/example");
    expect(soon.text).toContain("https://teams.microsoft.com/l/meetup-join/example");
  });

  it("renders the follow-up, naming the next session only when there is one", async () => {
    const withNext = await renderTemplate("follow_up", model);
    expect(withNext.subject).toBe("After your session: Claude, Claude Code & Advanced Workflows");
    expect(withNext.text).toContain("AI Agents & Autonomous Workflows");

    const last = await renderTemplate("follow_up", { ...model, nextSessionTitle: null });
    expect(last.text).not.toContain("follows on from this one");
  });

  it("omits the GST reference when the customer is already on Dubai time", async () => {
    const email = await renderTemplate("payment_receipt", { ...model, timeZone: "Asia/Dubai" });
    expect(email.text).toContain("18:00 - 19:30 (Asia/Dubai)");
    expect(email.text).not.toContain("GST,");
    expect(email.text).not.toMatch(/18:00 GST/);
  });

  it("refuses a key that has no template rather than sending something blank", async () => {
    await expect(renderTemplate("newsletter", model)).rejects.toThrow(TemplateNotAvailableError);
  });
});

describe("containsPlaceholder", () => {
  it("detects an identity placeholder in the text or the subject", async () => {
    // Identity is still placeholders in this repository, so a rendered email
    // carries them - which is exactly why the sweep refuses to send one.
    const email = await renderTemplate("payment_receipt", model);
    expect(containsPlaceholder(email)).toBe(true);
    expect(email.text).toContain("[COMPANY_NAME]");
  });

  it("passes an email with no placeholder", () => {
    expect(
      containsPlaceholder({
        subject: "Booked",
        html: "<p>[not shouting]</p>",
        text: "Booked [ok]",
      }),
    ).toBe(false);
  });
});
