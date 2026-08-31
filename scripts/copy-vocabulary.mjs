/**
 * Banned vocabulary, checked across ALL customer-facing copy.
 *
 * This is a COMMERCIAL rule, not a style preference. The business is coaching
 * and mentoring and issues no certification of any kind (D15). This vocabulary
 * is what would pull it into regulatory scope, so a single occurrence in a
 * component matters as much as one in the session catalogue.
 *
 * The rule was previously enforced by a test that scanned exactly two arrays -
 * FAQS and SESSIONS - while HANDOFF.md recorded that guards failed on this
 * vocabulary "anywhere in copy". Every component, every page, and all metadata
 * were unchecked, so an ordinary copy edit could have shipped the word.
 */

const BANNED =
  /\b(certificates?|certifications?|certified|diplomas?|qualifications?|accredited|accreditation|institutes?|academy|academies|graduates?|enrol|enroll|enrolment|enrollment)\b/gi;

/**
 * Files carrying a deliberate use, each with its reason - and each exempting
 * ONLY the words it names.
 *
 * This was FILE-level while this very comment said "lines", which is the same
 * overclaim the guard was written to end. SiteFooter.tsx renders on every page
 * and was wholly exempt: a footer containing "certificate", "accreditation"
 * and "academy" returned zero findings.
 *
 * Anything in an allowlisted file beyond the words it names is still reported.
 */
export const VOCABULARY_ALLOWLIST = {
  "src/components/layout/SiteFooter.tsx": {
    reason:
      "The D15 disclaimer states that no qualification or award is issued. It must name the thing it denies.",
    allow: ["qualification"],
  },
  "src/app/training/privacy/page.tsx": {
    reason:
      "Refers to a qualified external legal adviser, not to the business or to anything it issues.",
    allow: ["qualified"],
  },
  "src/app/training/terms/page.tsx": {
    reason:
      "Refers to a qualified external legal adviser, not to the business or to anything it issues.",
    allow: ["qualified"],
  },
};

const GOVERNED = /^src\/(config|components|app)\/.*\.(ts|tsx)$/;
const IS_TEST = /\.test\.(ts|tsx)$/;

/**
 * Only strings a customer could read.
 *
 * Identifiers and imports are skipped: a variable named `certificateUrl` is
 * not copy, and flagging it would train everyone to ignore this check. Comments
 * are skipped for the same reason - this file's own explanation of the rule
 * would otherwise fail it.
 */
function customerFacingText(line) {
  const withoutComments = line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
  if (/^\s*import\s/.test(withoutComments)) return "";

  const strings = withoutComments.matchAll(/["'`]([^"'`]{2,})["'`]/g);
  const quoted = [...strings].map((m) => m[1]).join(" ");

  // Text between JSX tags is copy too, and carries no quotes.
  const jsxText = withoutComments.replace(/<[^>]*>/g, " ").replace(/\{[^}]*\}/g, " ");

  return `${quoted} ${jsxText}`;
}

export function checkCopyVocabulary(files, allowlist = VOCABULARY_ALLOWLIST) {
  const problems = [];

  for (const file of files) {
    if (!GOVERNED.test(file.path) || IS_TEST.test(file.path)) continue;

    const entry = allowlist[file.path];
    const hasReason =
      entry !== undefined && typeof entry.reason === "string" && entry.reason.trim().length >= 20;
    /*
      An entry without an adequate reason exempts NOTHING. An unexplained
      exemption is how a real occurrence gets filed as deliberate.
    */
    const permitted = hasReason ? entry.allow.map((word) => word.toLowerCase()) : [];

    file.content.split(/\r?\n/).forEach((line, index) => {
      const text = customerFacingText(line);
      for (const match of text.matchAll(BANNED)) {
        const hit = match[0];
        // Exempt only the exact words this file was allowed, never the file.
        if (permitted.includes(hit.toLowerCase())) continue;
        problems.push(
          `${file.path}:${index + 1}: banned vocabulary "${hit}" in customer-facing copy ` +
            `- this business issues no certification (D15).`,
        );
      }
    });
  }

  for (const [path, entry] of Object.entries(allowlist)) {
    if (!files.some((f) => f.path === path)) {
      problems.push(`${path}: vocabulary allowlist names a file that does not exist.`);
      continue;
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
      problems.push(`${path}: vocabulary allowlist entry has no adequate reason.`);
    }
    if (!Array.isArray(entry.allow) || entry.allow.length === 0) {
      problems.push(
        `${path}: vocabulary allowlist entry must name the words it permits - ` +
          `exempting a whole file is what this guard was written to stop.`,
      );
    }
  }

  return problems;
}
