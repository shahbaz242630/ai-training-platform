import { describe, it, expect } from "vitest";
import {
  TEMPLATE_KINDS,
  decideSend,
  decideSendTemplate,
  isTransactional,
  type ConsentState,
  type TemplateKey,
} from "./sending-policy";

const declined: ConsentState = { marketingConsent: false, unsubscribedAt: null };
const optedIn: ConsentState = { marketingConsent: true, unsubscribedAt: null };
const unsubscribed: ConsentState = {
  marketingConsent: true,
  unsubscribedAt: new Date("2026-09-01T10:00:00.000Z"),
};

/*
  THE RULE THIS FILE EXISTS FOR.

  Somebody who does not want offers has still paid for a session, and must be
  told when it is. Every one of these is a way that could quietly stop
  happening.
*/
describe("a customer who did not tick the marketing box", () => {
  const mustStillArrive: TemplateKey[] = [
    "booking_confirmation",
    "intake_link",
    "reminder_24h",
    "reminder_3h",
    "reschedule_confirmation",
    "cancellation_confirmation",
    "payment_receipt",
    "follow_up",
  ];

  it.each(mustStillArrive)("still receives %s", (templateKey) => {
    expect(decideSendTemplate(templateKey, declined).allowed).toBe(true);
  });

  it("does not receive offers or news", () => {
    expect(decideSendTemplate("session_offers", declined).allowed).toBe(false);
    expect(decideSendTemplate("newsletter", declined).allowed).toBe(false);
  });
});

/*
  Unsubscribing stops marketing. It does not cancel somebody's session, and it
  does not waive their right to be told when it is.
*/
describe("a customer who has unsubscribed", () => {
  it("still receives the confirmation and reminders for a session they booked", () => {
    expect(decideSendTemplate("booking_confirmation", unsubscribed).allowed).toBe(true);
    expect(decideSendTemplate("reminder_24h", unsubscribed).allowed).toBe(true);
    expect(decideSendTemplate("reminder_3h", unsubscribed).allowed).toBe(true);
  });

  it("receives no marketing, even though the consent flag is still true", () => {
    // Withdrawal outranks the flag. A later booking form arriving with the box
    // ticked must not quietly resurrect a withdrawal.
    expect(unsubscribed.marketingConsent).toBe(true);
    const decision = decideSendTemplate("session_offers", unsubscribed);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("unsubscribed");
  });
});

describe("a customer who opted in", () => {
  it("receives marketing and everything else", () => {
    expect(decideSendTemplate("session_offers", optedIn).allowed).toBe(true);
    expect(decideSendTemplate("booking_confirmation", optedIn).allowed).toBe(true);
  });
});

describe("classification", () => {
  it("classifies every template, so none can be sent unclassified", () => {
    for (const [templateKey, kind] of Object.entries(TEMPLATE_KINDS)) {
      expect(["transactional", "marketing"]).toContain(kind);
      expect(templateKey.length).toBeGreaterThan(0);
    }
  });

  /*
    Reachable from a database row or a future template somebody forgot to add
    to the table, even though the type system forbids it here. Refusing is the
    safe direction: an unsent marketing email is a nuisance; an unclassified
    one sent to somebody who opted out is a complaint.
  */
  it("refuses a template it has never heard of", () => {
    const decision = decideSendTemplate("something_new" as TemplateKey, optedIn);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not classified");
  });

  it("reports which templates are transactional", () => {
    expect(isTransactional("booking_confirmation")).toBe(true);
    expect(isTransactional("newsletter")).toBe(false);
  });

  // The caller passes a template key rather than a kind precisely so it cannot
  // declare its own message transactional to get past the check.
  it("decides on the kind the table says, not the one a caller claims", () => {
    expect(decideSend("marketing", declined).allowed).toBe(false);
    expect(decideSendTemplate("newsletter", declined).allowed).toBe(false);
  });

  it("gives a reason plain enough to mean something in an audit trail", () => {
    expect(decideSendTemplate("booking_confirmation", declined).reason).toContain("transactional");
    expect(decideSendTemplate("session_offers", declined).reason).toContain("no recorded consent");
  });
});
