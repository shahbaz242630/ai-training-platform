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

/*
  Indexing must not arm while a placeholder can still reach a crawler.

  isPubliclyConfigured used to check three fields. Those three are the natural
  first ones to fill in - so filling them armed indexing while supportEmail and
  instructorName were still null, and a crawler would take `[SUPPORT_EMAIL]`
  straight into a search result. A guard with a blind spot exactly where it
  matters is worse than no guard, because it reads as one.
*/
describe("indexing cannot arm on partial identity", () => {
  const complete = {
    companyName: "Real Co",
    legalEntityName: "Real Co FZ-LLC",
    domain: "real.example",
    supportEmail: "hello@real.example",
    phone: "+971 4 000 0000",
    instructorName: "A Person",
    instructorBio: "A bio.",
    serviceArea: "Dubai, United Arab Emirates",
  };

  it("is configured only when every rendered field is real", () => {
    expect(isPubliclyConfigured(complete)).toBe(true);
  });

  /*
    Each of these renders on a page a crawler can reach. Leaving any of them
    null while indexing is on publishes a bracketed token.
  */
  it("refuses to arm while any rendered field is still a placeholder", () => {
    const rendered = [
      "companyName",
      "legalEntityName",
      "domain",
      "supportEmail",
      "instructorName",
    ] as const;

    for (const field of rendered) {
      expect(isPubliclyConfigured({ ...complete, [field]: null }), field).toBe(false);
    }
  });

  // The exact shape that used to slip through: the obvious three filled in.
  it("refuses the three-field configuration that previously armed indexing", () => {
    expect(
      isPubliclyConfigured({
        ...complete,
        supportEmail: null,
        instructorName: null,
      }),
    ).toBe(false);
  });

  /*
    The four literals that bypassed the guard entirely: a hardcoded
    "[COMPANY_NAME]" in a title template is invisible to a check that only
    looks at config. They now route through the placeholder helpers, so this
    asserts none survives in a page or component.
  */
  it("has no hardcoded placeholder tokens left in pages or components", async () => {
    const { readFileSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");

    const paths = execFileSync("git", ["ls-files"], { encoding: "utf8" })
      .split("\n")
      .filter((p) => /^src\/(app|components)\/.*\.(ts|tsx)$/.test(p) && !p.includes(".test."));

    const offenders: string[] = [];
    for (const path of paths) {
      const content = readFileSync(path, "utf8");
      // Legal pages hold approved-copy placeholders deliberately and are
      // noindex in their own right, so they are not part of this rule.
      if (path.includes("/privacy/") || path.includes("/terms/")) continue;
      if (path.includes("/refunds-cancellations/")) continue;
      if (/\[(COMPANY_NAME|LEGAL_ENTITY_NAME|SUPPORT_EMAIL|INSTRUCTOR_NAME)\]/.test(content)) {
        offenders.push(path);
      }
    }

    expect(offenders).toEqual([]);
  });
});
