import { describe, it, expect } from "vitest";
import { VOCABULARY_ALLOWLIST, checkCopyVocabulary } from "./copy-vocabulary.mjs";

/**
 * A commercial rule, not a style preference. This vocabulary is what would
 * pull a coaching business into regulatory scope, so one occurrence in a
 * component matters as much as one in the catalogue.
 *
 * The rule was previously enforced across exactly two arrays while the handoff
 * recorded that it applied "anywhere in copy". Every component, page and piece
 * of metadata was unchecked.
 */

const file = (path, content) => [{ path, content }];

describe("checkCopyVocabulary", () => {
  it("catches a banned word in a component, which was previously unchecked", () => {
    const problems = checkCopyVocabulary(
      file("src/components/training/Hero.tsx", "<p>Earn a certificate today</p>"),
      {},
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("certificate");
  });

  it("catches one in page metadata", () => {
    const problems = checkCopyVocabulary(
      file("src/app/training/page.tsx", 'export const metadata = { title: "AI Academy" };'),
      {},
    );
    expect(problems).toHaveLength(1);
  });

  it("catches plurals and both spellings of enrolment", () => {
    for (const word of ["certificates", "diplomas", "enrol", "enrollment", "academies"]) {
      const problems = checkCopyVocabulary(
        file("src/config/faqs.ts", `const a = "We offer ${word} here";`),
        {},
      );
      expect(problems.length, word).toBeGreaterThan(0);
    }
  });

  it("catches text between JSX tags, which carries no quotes", () => {
    const problems = checkCopyVocabulary(
      file("src/components/training/Faq.tsx", "<span>fully accredited</span>"),
      {},
    );
    expect(problems).toHaveLength(1);
  });

  /*
    An identifier is not copy. Flagging one would train everybody to ignore
    this check, which is how a real occurrence gets waved through.
  */
  it("ignores identifiers and imports", () => {
    expect(
      checkCopyVocabulary(file("src/config/x.ts", "const certificateUrl = getUrl();"), {}),
    ).toEqual([]);
    expect(
      checkCopyVocabulary(file("src/config/x.ts", 'import { academy } from "./academy";'), {}),
    ).toEqual([]);
  });

  it("ignores comments, so a file may explain the rule it enforces", () => {
    expect(
      checkCopyVocabulary(file("src/config/x.ts", "// never say certificate or diploma"), {}),
    ).toEqual([]);
  });

  it("does not govern domain, data or lib - those hold no customer copy", () => {
    expect(checkCopyVocabulary(file("src/domain/x.ts", 'const a = "certificate";'), {})).toEqual(
      [],
    );
  });

  /*
    The one deliberate use: a disclaimer must be able to name the thing it
    denies. Removing the denial to satisfy a word list would invert the rule.
  */
  const footerAllowing = (words) => ({
    "src/components/layout/SiteFooter.tsx": {
      reason: "The D15 disclaimer must name the thing it denies, and nothing more than that.",
      allow: words,
    },
  });

  it("allows the exact word a file was permitted", () => {
    const problems = checkCopyVocabulary(
      file("src/components/layout/SiteFooter.tsx", "<p>no qualification is issued</p>"),
      footerAllowing(["qualification"]),
    );
    expect(problems).toEqual([]);
  });

  /*
    THE hole this closes. The allowlist was FILE-level while its own docstring
    said "lines", so SiteFooter - which renders on every page - was wholly
    exempt. A footer could have carried "certificate", "accreditation" and
    "academy" and returned zero findings.
  */
  it("still catches other banned words in an allowlisted file", () => {
    const problems = checkCopyVocabulary(
      file(
        "src/components/layout/SiteFooter.tsx",
        "<p>no qualification is issued by our accredited academy</p>",
      ),
      footerAllowing(["qualification"]),
    );
    expect(problems).toHaveLength(2);
    expect(problems.join(" ")).toContain("accredited");
    expect(problems.join(" ")).toContain("academy");
  });

  it("refuses an allowlist entry with no adequate reason", () => {
    const problems = checkCopyVocabulary(
      file("src/components/layout/SiteFooter.tsx", "<p>accredited</p>"),
      { "src/components/layout/SiteFooter.tsx": { reason: "ok", allow: ["accredited"] } },
    );
    expect(problems.length).toBeGreaterThan(0);
  });

  // An entry naming no words is a file-level exemption by the back door.
  it("refuses an allowlist entry that names no permitted words", () => {
    const problems = checkCopyVocabulary(
      file("src/components/layout/SiteFooter.tsx", "<p>hi</p>"),
      {
        "src/components/layout/SiteFooter.tsx": {
          reason: "A reason long enough to pass the length check but naming nothing.",
          allow: [],
        },
      },
    );
    expect(problems.join(" ")).toContain("must name the words it permits");
  });

  it("reports an allowlist entry naming a file that does not exist", () => {
    const problems = checkCopyVocabulary(file("src/config/x.ts", "const a = 1;"), {
      "src/components/Gone.tsx": {
        reason: "A reason that was true once, for a file since deleted.",
        allow: ["certificate"],
      },
    });
    expect(problems[0]).toContain("does not exist");
  });
});

describe("the real vocabulary allowlist", () => {
  it("gives every entry a written reason", () => {
    for (const [path, entry] of Object.entries(VOCABULARY_ALLOWLIST)) {
      expect(typeof entry.reason, path).toBe("string");
      expect(entry.reason.trim().length, path).toBeGreaterThanOrEqual(20);
      // And it must name what it permits, rather than exempting the file.
      expect(Array.isArray(entry.allow), path).toBe(true);
      expect(entry.allow.length, path).toBeGreaterThan(0);
    }
  });
});
