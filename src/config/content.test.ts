import { describe, it, expect } from "vitest";
import { FAQS } from "./faqs";
import { SESSIONS } from "./sessions";
import {
  BOOKING_POLICY,
  COMPANY_NAV_LINKS,
  FOOTER_LINKS,
  POLICY_LINKS,
  COMPANY_SITE_URL,
  SITE,
  isPubliclyConfigured,
  placeholder,
} from "./site";
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

  it("states only the approved cancellation terms", () => {
    const faq = FAQS.find((f) => f.id === "cancellation")!;
    // Every period it names is one of the approved policy numbers, so the FAQ
    // cannot promise a notice period or window the policy does not give.
    const periods = [...faq.answer.matchAll(/\b(\d+)\s*(hours?|days?|minutes?)\b/gi)].map(
      (m) => `${m[1]} ${(m[2] ?? "").toLowerCase().replace(/s$/, "")}`,
    );
    const approved = [
      `${BOOKING_POLICY.moveNoticeHours} hour`,
      `${BOOKING_POLICY.moveWindowDays} day`,
      `${BOOKING_POLICY.noShowMinutes} minute`,
      `${BOOKING_POLICY.cancellationDays} day`,
    ];
    expect(periods.length).toBeGreaterThan(0);
    for (const p of periods) expect(approved).toContain(p);
    // Never a percentage refund, and never a bare "no refunds" (the policy
    // always refunds when we cancel).
    expect(faq.answer).not.toMatch(/\b\d+\s*%/);
    expect(faq.answer).toMatch(/if we cancel, you choose a full refund or a new time/i);
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

/*
  The header's way back to the company site. zaaheen.com is a separate build,
  so nothing type-checks these links against it: a relative href here would
  resolve to coaching.zaaheen.com and 404, and a missing trailing slash costs a
  redirect on every click.
*/
describe("company top bar", () => {
  it("mirrors the company site's tabs, in its order", () => {
    expect(COMPANY_NAV_LINKS.map((l) => l.label)).toEqual([
      "Products",
      "Documents",
      "Knowledge Centre",
    ]);
  });

  it("links only to canonical pages on the company site", () => {
    expect(COMPANY_SITE_URL).toBe("https://zaaheen.com");
    for (const link of COMPANY_NAV_LINKS) {
      expect(link.href, link.label).toMatch(/^https:\/\/zaaheen\.com\/[a-z-]+\/$/);
    }
  });
});

describe("placeholder discipline", () => {
  it("renders unfilled values as visible bracketed tokens", () => {
    expect(placeholder(null, "COMPANY_NAME")).toBe("[COMPANY_NAME]");
    expect(placeholder("Acme", "COMPANY_NAME")).toBe("Acme");
  });

  /*
    These two used to assert the placeholder state itself - that every identity
    field was null - which meant filling in the real company name turned the
    gate red until the tests were rewritten. They now assert the rule, which
    holds before and after: structured data exists exactly when identity is
    public, and a field is either unset or real, never a guess.
  */
  it("publishes structured data exactly when identity is publicly configured", () => {
    expect(buildTrainingJsonLd() === null).toBe(!isPubliclyConfigured());
  });

  it("keeps every identity field either unset or real, never guessed", () => {
    // A bracketed token, a dummy word, or a host that is not ours.
    const guessed =
      /^\[.*\]$|\b(example|acme|placeholder|tbd|todo|lorem)\b|hostingersite|localhost/i;
    const fields = [
      "companyName",
      "legalEntityName",
      "domain",
      "supportEmail",
      "instructorName",
      "instructorBio",
      "phone",
    ] as const;

    for (const field of fields) {
      const value = SITE[field];
      if (value === null) continue;
      expect(value.trim().length, field).toBeGreaterThan(0);
      expect(value, field).not.toMatch(guessed);
    }
    if (SITE.supportEmail !== null) expect(SITE.supportEmail).toMatch(/^[^@\s]+@[^@\s]+\.[^@\s]+$/);
    // A bare host name. A scheme or a path here would break every URL built from it.
    if (SITE.domain !== null) expect(SITE.domain).not.toMatch(/^https?:|\//);
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
    const rendered = ["companyName", "legalEntityName", "domain", "supportEmail"] as const;

    for (const field of rendered) {
      expect(isPubliclyConfigured({ ...complete, [field]: null }), field).toBe(false);
    }
  });

  /*
    The coach's name renders nowhere (founder, 2026-09-25: no name or bio for
    now), so it must not hold indexing back. The moment a page or component
    renders it, the second test fails: put it back in isPubliclyConfigured then.
  */
  it("does not hold indexing back on a coach name that renders nowhere", () => {
    expect(isPubliclyConfigured({ ...complete, instructorName: null, instructorBio: null })).toBe(
      true,
    );
  });

  it("renders the coach's name and bio nowhere", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join } = await import("node:path");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if (path.replace(/\\/g, "/").endsWith("src/config/site.ts")) continue;
          if (/instructorName|instructorBio/.test(readFileSync(path, "utf8"))) offenders.push(path);
        }
      }
    };
    walk(join(process.cwd(), "src"));
    expect(offenders).toEqual([]);
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
      if (/\[(COMPANY_NAME|LEGAL_ENTITY_NAME|SUPPORT_EMAIL|INSTRUCTOR_NAME)\]/.test(content)) {
        offenders.push(path);
      }
    }

    expect(offenders).toEqual([]);
  });
});

/*
  The company-wide copy rule (zaaheen.com SEO-HANDOFF §3a rule 6): no em dash,
  and no spaced en dash standing in for one, in anything a visitor reads. Readers
  take it as "AI wrote this". Comments are stripped first, so explanations in
  code may still use them; an en dash inside a number range is fine.
*/
describe("no long dashes in customer-facing text", () => {
  it("has none in pages, components or config", async () => {
    const { readFileSync } = await import("node:fs");
    const { execFileSync } = await import("node:child_process");

    const paths = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
    })
      .split("\n")
      .filter(
        (p) =>
          /^src\/(app|components|config|emails)\/.*\.(ts|tsx)$/.test(p) && !p.includes(".test."),
      );

    const offenders: string[] = [];
    for (const path of paths) {
      const code = readFileSync(path, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
      for (const m of code.matchAll(/—|\s–\s/g)) {
        const at = m.index ?? 0;
        offenders.push(
          `${path}: "${code.slice(Math.max(0, at - 25), at + 25).replace(/\s+/g, " ")}"`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("policy links", () => {
  it("links the footer to the three coaching policies on the company site", () => {
    expect(FOOTER_LINKS.map((l) => l.href)).toEqual([
      POLICY_LINKS.terms,
      POLICY_LINKS.bookingAndRefunds,
      POLICY_LINKS.privacy,
    ]);
    for (const href of Object.values(POLICY_LINKS)) {
      expect(href.startsWith(`${COMPANY_SITE_URL}/knowledge-centre/`)).toBe(true);
      expect(href.endsWith("/")).toBe(true);
    }
  });
});
