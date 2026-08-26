import { describe, it, expect } from "vitest";
import { FAQS } from "./faqs";
import { SESSIONS } from "./sessions";
import { SITE, isPubliclyConfigured, placeholder } from "./site";
import { buildTrainingJsonLd } from "@/lib/structured-data";

/**
 * These guard commercial and legal rules that are easy to break during ordinary
 * copy edits. They are cheap, and they fail loudly - which is the point.
 */

// This is a coaching and mentoring business that issues no certification of any
// kind. This vocabulary would misrepresent that, so it is a commercial rule
// rather than a style preference.
const BANNED =
  /\b(certificate|certification|certified|diploma|qualification|accredited|accreditation|institute|academy|graduate|enrol|enrolment|enrollment)\b/i;

describe("customer-facing copy", () => {
  it("contains no certification or institute vocabulary in FAQs", () => {
    for (const faq of FAQS) {
      expect(faq.question, faq.id).not.toMatch(BANNED);
      expect(faq.answer, faq.id).not.toMatch(BANNED);
    }
  });

  it("contains no certification or institute vocabulary in session copy", () => {
    for (const s of SESSIONS) {
      const copy = [
        s.title,
        s.summary,
        s.outcome,
        s.audience,
        s.prerequisiteNote ?? "",
        ...s.topics,
      ].join(" ");
      expect(copy, s.code).not.toMatch(BANNED);
    }
  });

  it("answers every question required by the PRD", () => {
    const required = [
      "technical-experience",
      "which-session",
      "online",
      "evenings",
      "single-session",
      "combine-sessions",
      "session-six",
      "build-for-me",
      "prepare",
      "cancellation",
    ];
    const ids = FAQS.map((f) => f.id);
    for (const id of required) expect(ids).toContain(id);
  });

  it("does not invent cancellation terms", () => {
    const faq = FAQS.find((f) => f.id === "cancellation")!;
    // Must defer to the policy page rather than stating invented specifics such
    // as a concrete notice period or a refund percentage.
    expect(faq.answer).not.toMatch(/\b\d+\s*(hours?|days?)\b/i);
    expect(faq.answer).not.toMatch(/\b\d+\s*%/);
  });

  it("does not imply pathways are purchasable while they are disabled", () => {
    const faq = FAQS.find((f) => f.id === "combine-sessions")!;
    expect(faq.answer.toLowerCase()).toContain("not");
  });

  it("states the Session 6 scope boundary so marketing cannot imply unlimited work", () => {
    const faq = FAQS.find((f) => f.id === "build-for-me")!;
    expect(faq.answer.toLowerCase()).toContain("not outsourced development");
  });
});

describe("placeholder discipline", () => {
  it("renders unfilled values as visible bracketed tokens", () => {
    expect(placeholder(null, "COMPANY_NAME")).toBe("[COMPANY_NAME]");
    expect(placeholder("Acme", "COMPANY_NAME")).toBe("Acme");
  });

  it("suppresses structured data until a real identity exists", () => {
    // Guards against publishing "[COMPANY_NAME]" into search and answer engines.
    expect(isPubliclyConfigured()).toBe(false);
    expect(buildTrainingJsonLd()).toBeNull();
  });

  it("keeps company identity unset rather than guessed", () => {
    expect(SITE.companyName).toBeNull();
    expect(SITE.legalEntityName).toBeNull();
    expect(SITE.instructorName).toBeNull();
  });
});
