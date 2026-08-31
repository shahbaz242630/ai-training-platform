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
 * Lines carrying a deliberate use, each with its reason.
 *
 * There is exactly one today: the footer disclaimer that DENIES issuing a
 * qualification. It has to say the word to deny it, and removing the denial to
 * satisfy a word list would be the opposite of the rule's intent.
 */
export const VOCABULARY_ALLOWLIST = {
  "src/components/layout/SiteFooter.tsx":
    "The D15 disclaimer states that no qualification or award is issued. It must name the thing it denies.",
  "src/app/training/privacy/page.tsx":
    "Refers to a qualified external legal adviser, not to the business or to anything it issues.",
  "src/app/training/terms/page.tsx":
    "Refers to a qualified external legal adviser, not to the business or to anything it issues.",
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

    const reason = allowlist[file.path];
    const allowed = typeof reason === "string" && reason.trim().length >= 20;
    if (allowed) continue;

    file.content.split(/\r?\n/).forEach((line, index) => {
      const text = customerFacingText(line);
      const hits = [...text.matchAll(BANNED)].map((m) => m[0]);
      for (const hit of hits) {
        problems.push(
          `${file.path}:${index + 1}: banned vocabulary "${hit}" in customer-facing copy ` +
            `- this business issues no certification (D15).`,
        );
      }
    });
  }

  for (const path of Object.keys(allowlist)) {
    if (!files.some((f) => f.path === path)) {
      problems.push(`${path}: vocabulary allowlist names a file that does not exist.`);
    }
  }

  return problems;
}
