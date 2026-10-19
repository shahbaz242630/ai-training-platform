import { describe, expect, it } from "vitest";
import {
  refundAlertReason,
  renderCalendarEventChanged,
  renderPaidBookingNeedsTime,
  renderRefundNeedsAttention,
} from "./desk-alerts";
import { supportEmail } from "@/config/site";
import type { PaidButUnscheduled } from "@/data/audit-events";
import type { CalendarProblem } from "@/data/calendar-watch";
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

describe("renderCalendarEventChanged", () => {
  const booked = {
    start: new Date("2026-10-20T15:00:00Z"),
    end: new Date("2026-10-20T16:30:00Z"),
  };
  const gone: CalendarProblem = {
    bookingId: "3f9a1c2b-0000-4000-8000-000000000001",
    kind: "gone",
    booked,
  };
  const moved: CalendarProblem = {
    bookingId: "3f9a1c2b-0000-4000-8000-000000000001",
    kind: "moved",
    booked,
    calendar: {
      start: new Date("2026-10-20T17:00:00Z"),
      end: new Date("2026-10-20T18:30:00Z"),
    },
  };

  it("names the booking and the booked time in Dubai in the subject", async () => {
    expect((await renderCalendarEventChanged(gone, false)).subject).toBe(
      "Session missing from the calendar: booking 3F9A1C2B, Tue 20 Oct, 19:00 Dubai time",
    );
    expect((await renderCalendarEventChanged(moved, false)).subject).toBe(
      "Session moved in the calendar only: booking 3F9A1C2B, Tue 20 Oct, 19:00 Dubai time",
    );
  });

  it("marks a reminder as one", async () => {
    expect((await renderCalendarEventChanged(gone, true)).subject).toMatch(
      /^Reminder: Session missing from the calendar: /,
    );
  });

  it("tells the desk to restore a deleted event, not to make a new one", async () => {
    const { text } = await renderCalendarEventChanged(gone, false);
    expect(text).toContain(
      "The Outlook event for this booked session has been deleted or cancelled.",
    );
    expect(text).toContain("The customer has not been told");
    expect(text).toContain("The time stays blocked, so nobody else can book it.");
    expect(text).toContain("restore the event from Deleted Items in Outlook");
    expect(text).toContain("Do not make a new event");
    expect(text).toContain("If the session cannot go ahead, contact the customer");
  });

  it("says plainly that moving the event did not move the booking, with both times", async () => {
    const { text } = await renderCalendarEventChanged(moved, false);
    expect(text).toContain(
      "Moving the event in Outlook does not move the booking, and the customer has not been told.",
    );
    expect(text).toContain("Tue 20 Oct, 19:00 Dubai time");
    expect(text).toContain("Tue 20 Oct, 21:00 Dubai time");
    expect(text).toContain("Manage my booking link");
  });

  it("carries the booking reference and nothing about the customer", async () => {
    for (const problem of [gone, moved]) {
      const { text, html } = await renderCalendarEventChanged(problem, false);
      expect(text).toContain("3F9A1C2B");
      // No email address at all, but the desk's own in the shared footer.
      expect(`${text}${html}`.replaceAll(supportEmail(), "")).not.toMatch(
        /[\w.+-]+@[\w-]+\.[\w.-]+/,
      );
    }
  });
});

describe("renderPaidBookingNeedsTime", () => {
  const waiting: PaidButUnscheduled = {
    orderId: "00000000-0000-4000-8000-0000000000aa",
    bookingId: "3f9a1c2b-0000-4000-8000-000000000001",
    sessionSlug: "claude-claude-code",
    amountFils: 149_900,
    paymentIntentId: "pi_3Lost",
    fullyPaid: true,
    disputed: false,
    waitingSince: new Date("2027-01-01T10:00:00Z"),
    customerEmailedAt: new Date("2027-01-01T10:05:00Z"),
    customerEmailPending: false,
  };
  const link = "https://example.test/training/book/manage?t=v1.abc";

  it("names the booking and the amount in the subject, and marks a reminder", async () => {
    expect((await renderPaidBookingNeedsTime(waiting, false, link)).subject).toBe(
      "Paid, no session time: booking 3F9A1C2B, AED 1,499",
    );
    expect((await renderPaidBookingNeedsTime(waiting, true, link)).subject).toBe(
      "Reminder: Paid, no session time: booking 3F9A1C2B, AED 1,499",
    );
  });

  it("says what happened, what to do, how it ends, and which payment to look at", async () => {
    const email = await renderPaidBookingNeedsTime(waiting, false, link);
    expect(email.text).toContain("Claude, Claude Code & Advanced Workflows");
    expect(email.text).toContain("has no time on the calendar");
    // The customer is sent their own link by the sweep (founder decision, October 2026).
    expect(email.text).toContain("emailed their own link to choose a new time");
    expect(email.text).toContain("Nothing to do unless the customer writes");
    expect(email.text).toContain("If they ask for their money back instead");
    expect(email.text).toContain("Do not charge again.");
    expect(email.text).toContain("once the customer has chosen a time");
    expect(email.text).toContain("refunded in full in Stripe");
    expect(email.text).toContain("pi_3Lost");
  });

  it("carries the customer's link to choose a new time, which is not their one move", async () => {
    const email = await renderPaidBookingNeedsTime(waiting, false, link);
    expect(email.text).toContain(link);
    expect(email.html).toContain(`href="${link}"`);
    expect(email.text).toContain("does not use up their one move");
    expect(email.text).toContain("each reminder carries a fresh one");
  });

  /*
    After a dispute the person who booked may not be the cardholder (a stolen
    card), so nobody was sent a link: the desk checks first.
  */
  it("after a dispute, says the customer was not sent a link and to check Stripe first", async () => {
    const email = await renderPaidBookingNeedsTime({ ...waiting, disputed: true }, false, link);
    expect(email.text).toContain("has not been told");
    expect(email.text).toContain("not sent a link");
    expect(email.text).toContain("cannot choose a time online");
    expect(email.text).toContain("Check the dispute in Stripe first");
    expect(email.text).not.toContain(link);
  });

  // Only an email that actually went counts: a withdrawn, failed or not-yet-sent one does not.
  it("when the customer has not actually been emailed, tells the desk to write to them with the link", async () => {
    const email = await renderPaidBookingNeedsTime(
      { ...waiting, customerEmailedAt: null },
      false,
      link,
    );
    expect(email.text).toContain("has not been told");
    expect(email.text).toContain("offer them a new time or a full refund");
    expect(email.text).toContain(link);
    expect(email.text).not.toContain("Nothing to do unless");
  });

  it("without a link, offers only the refund and says why", async () => {
    const noLink = await renderPaidBookingNeedsTime(waiting, false, null);
    expect(noLink.text).toContain("offer a full refund");
    expect(noLink.text).not.toContain("new time or");
    expect(noLink.text).not.toContain("manage?t=");

    const partRefunded = await renderPaidBookingNeedsTime(
      { ...waiting, fullyPaid: false },
      false,
      null,
    );
    expect(partRefunded.text).toContain("partly refunded");
  });

  it("carries nothing about the customer and no long dashes", async () => {
    for (const url of [link, null]) {
      const email = await renderPaidBookingNeedsTime(waiting, false, url);
      for (const part of [email.subject, email.text, email.html]) {
        expect(part).not.toMatch(/[–—]/);
        expect(part.replaceAll(supportEmail(), "")).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      }
    }
  });

  it("still makes sense with no booking row and no payment id", async () => {
    const email = await renderPaidBookingNeedsTime(
      { ...waiting, bookingId: null, sessionSlug: null, paymentIntentId: null },
      false,
      null,
    );
    expect(email.subject).toBe("Paid, no session time: booking unknown, AED 1,499");
    expect(email.text).toContain("no payment on record");
  });
});
