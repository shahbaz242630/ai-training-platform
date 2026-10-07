import { describe, expect, it } from "vitest";
import {
  TemplateNotAvailableError,
  containsPlaceholder,
  renderTemplate,
  renderWithdrawalAcknowledgement,
  type SessionEmailModel,
} from "./templates";

/**
 * What a customer would actually read. These assert the facts every message
 * must carry - which session, when, in whose time zone - and that nothing a
 * template promises is missing from the model it was rendered from.
 */

const model: SessionEmailModel = {
  bookingId: "3f9a1c2b-0d4e-4f00-9a11-222233334444",
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

describe("the booking reference and the right to cancel", () => {
  it("are in the payment acknowledgement and the confirmation, with the withdrawal link prefilled", async () => {
    for (const key of ["payment_receipt", "booking_confirmation"] as const) {
      const email = await renderTemplate(key, model);
      expect(email.text).toContain("Booking reference: 3F9A1C2B");
      expect(email.html).toContain("/training/book/withdraw?ref=3F9A1C2B");
      expect(email.text).toContain("Withdraw from contract here");
      expect(email.html).toContain("https://zaaheen.com/knowledge-centre/terms/");
      expect(email.text).toContain("24 hours before it starts");
    }
  });
});

describe("containsPlaceholder", () => {
  it("detects an identity placeholder in the text or the subject", async () => {
    // The real identity is filled in, so the placeholder is planted: the sweep
    // must still refuse any email that would carry one.
    const email = await renderTemplate("payment_receipt", model);
    expect(containsPlaceholder({ ...email, text: `${email.text} [SUPPORT_EMAIL]` })).toBe(true);
    expect(containsPlaceholder({ ...email, subject: `[COMPANY_NAME] ${email.subject}` })).toBe(
      true,
    );
  });

  it("renders with the real identity and no placeholder", async () => {
    const email = await renderTemplate("payment_receipt", model);
    expect(containsPlaceholder(email)).toBe(false);
    expect(email.text).toContain("knowledgecentre@zaaheen.com");
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

/*
  The acknowledgement the law asks for when a customer withdraws: on a durable
  medium, straight away, with the notice itself, when it was received and the
  refund due.
*/
describe("renderWithdrawalAcknowledgement", () => {
  const withdrawal = {
    firstName: "Amina",
    sessionTitle: "Claude, Claude Code & Advanced Workflows",
    reference: "3F9A1C2B",
    statement:
      'I, Amina Khan, withdraw from my contract for the coaching session "Claude, Claude Code & Advanced Workflows" (booking reference 3F9A1C2B).',
    receivedAt: new Date("2026-10-07T09:05:00Z"),
    timeZone: "Europe/London",
    refundDueFils: 129_900,
  };

  it("quotes the notice, when it was received and the refund due", async () => {
    const email = await renderWithdrawalAcknowledgement(withdrawal);
    expect(email.subject).toBe("We have received your withdrawal (booking 3F9A1C2B)");
    expect(email.text).toContain("I, Amina Khan, withdraw from my contract");
    expect(email.text).toContain("Wednesday, 7 October 2026 at 10:05 (Europe/London)");
    expect(email.text).toContain("13:05 GST");
    expect(email.text).toContain("AED 1,299");
    expect(email.text).toContain("within 14 days");
    expect(email.text).toContain("3F9A1C2B");
  });

  it("tells the customer what to do if they did not send it", async () => {
    const email = await renderWithdrawalAcknowledgement(withdrawal);
    expect(email.text).toMatch(/did not send this/i);
  });

  it("omits the GST reference when the customer is on Dubai time", async () => {
    const email = await renderWithdrawalAcknowledgement({ ...withdrawal, timeZone: "Asia/Dubai" });
    expect(email.text).toContain("at 13:05 (Asia/Dubai)");
    expect(email.text).not.toContain("13:05 GST");
  });

  it("carries no identity placeholder", async () => {
    expect(containsPlaceholder(await renderWithdrawalAcknowledgement(withdrawal))).toBe(false);
  });
});
