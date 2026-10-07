#!/usr/bin/env node
/**
 * Fail if the installed Next.js is inside any advisory published on
 * vercel/next.js's own repository.
 *
 * Why this exists (security audit, 2026-09-27): GHSA-vcvr-r3jv-pc5j, a
 * critical remote-code-execution advisory against Next.js, was published on
 * the framework's repository days before it reached GitHub's reviewed advisory
 * database, which is all `pnpm audit` and Dependabot read. For the one
 * dependency that has had several critical advisories this year, the source
 * is read directly: on every pull request, every push to main and weekly.
 *
 *   node scripts/next-advisories.mjs          (needs GITHUB_TOKEN or GH_TOKEN)
 *
 * A failure to READ the advisories fails the check too. "Could not look" must
 * never look the same as "nothing found".
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * [major, minor, patch]; a pre-release sorts below its release. A short
 * version ("14", "13.3", as real advisories write them) is padded with zeros.
 */
function parseVersion(text) {
  // A leading "v" ("v16.0.7") is also seen on real advisories.
  const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[0-9A-Za-z.-]+)?$/.exec(text.trim());
  if (!match) throw new Error(`not a version: ${text}`);
  return {
    parts: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    pre: match[4] !== undefined,
  };
}

const VERSION = String.raw`v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?`;

const majorOf = (text) => parseVersion(text).parts[0];

export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (x.parts[i] !== y.parts[i]) return x.parts[i] < y.parts[i] ? -1 : 1;
  }
  if (x.pre !== y.pre) return x.pre ? -1 : 1;
  return 0;
}

/**
 * The patched versions on `version`'s own major line. `patched_versions` is a
 * comma list, sometimes with a leading "v".
 */
function patchesOnLine(version, patchedVersions) {
  if (typeof patchedVersions !== "string") return [];
  const major = majorOf(version);
  const plainVersion = new RegExp(`^${VERSION}$`);
  /*
    Free text is seen here too ("≤15.0.4 and ≥15.2.0"). A token that is not a
    plain version is ignored: that can only make a version look LESS patched,
    so the check errs towards flagging, never towards "safe".
  */
  return patchedVersions
    .split(/,|\band\b/)
    .map((p) => p.trim())
    .filter((p) => plainVersion.test(p) && majorOf(p) === major);
}

const COMPARATOR = new RegExp(`(>=|<=|>|<|=)\\s*(${VERSION})`, "g");

/**
 * One comma-separated alternative of a range, as vercel/next.js actually
 * writes them (every shape below was on a real advisory):
 *
 *   ">= 16.2.0 < 16.3.6"  "=>15.0 <15.2.3"  ">15.0.4 and <15.2.0"  "<14.2.7"
 *   "15.0.0 - 15.4.4"     "9.5.0 <= 9.5.3"  "13.x"  "16.0.0"  ">=16.0.1"
 *
 * Reduced to a lower and/or upper bound, or a release-line prefix. Anything
 * else throws, so a new format is noticed rather than read as "not affected".
 */
function parseAlternative(text) {
  const t = text
    .trim()
    .replace(/=>/g, ">=")
    .replace(/\band\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let m = new RegExp(`^(${VERSION}) - (${VERSION})$`).exec(t);
  if (m) return { lower: { op: ">=", v: m[1] }, upper: { op: "<=", v: m[2] } };
  m = /^v?(\d+)(?:\.(\d+))?\.x$/.exec(t);
  if (m)
    return {
      prefix: { major: Number(m[1]), minor: m[2] === undefined ? undefined : Number(m[2]) },
    };
  if (new RegExp(`^${VERSION}$`).test(t)) return { lower: { op: ">=", v: t } };
  m = new RegExp(`^(${VERSION}) ?(<=|<) ?(${VERSION})$`).exec(t);
  if (m) return { lower: { op: ">=", v: m[1] }, upper: { op: m[2], v: m[3] } };

  const comparators = [...t.matchAll(COMPARATOR)];
  if (comparators.length === 0 || t.replace(COMPARATOR, "").trim() !== "") {
    throw new Error(`unreadable version range: ${text}`);
  }
  const alt = {};
  for (const [, op, v] of comparators) {
    if (op === "=") return { lower: { op: ">=", v }, upper: { op: "<=", v } };
    if (op === ">=" || op === ">") alt.lower = { op, v };
    else alt.upper = { op, v };
  }
  return alt;
}

function satisfies(version, bound) {
  const c = compareVersions(version, bound.v);
  if (bound.op === ">=") return c >= 0;
  if (bound.op === ">") return c > 0;
  if (bound.op === "<=") return c <= 0;
  return c < 0;
}

/**
 * Whether one alternative affects `version`. A range with an upper bound
 * decides by itself. An open-ended one (a bare version, "13.x", ">=16.0.1")
 * gives only where the flaw began, so `patched_versions` decides where it
 * ends: the version is affected unless it has reached the fix on its own line.
 * An open-ended start on an OLDER line, with no fix named on this line, says
 * nothing about this line (those advisories list each line separately).
 */
function alternativeAffects(version, alt, patchedVersions) {
  const fixes = patchesOnLine(version, patchedVersions);
  const patched = fixes.some((p) => compareVersions(version, p) >= 0);

  if (alt.prefix) {
    const [major, minor] = parseVersion(version).parts;
    if (major !== alt.prefix.major) return false;
    if (alt.prefix.minor !== undefined && minor !== alt.prefix.minor) return false;
    return !patched;
  }
  if (alt.lower && !satisfies(version, alt.lower)) return false;
  if (alt.upper) return satisfies(version, alt.upper);
  if (patched) return false;
  return majorOf(alt.lower.v) === majorOf(version) || fixes.length > 0;
}

/** Whether `version` is affected by one vulnerable range (with its patched versions). */
export function inRange(version, range, patchedVersions = null) {
  return range
    .split(",")
    .map(parseAlternative)
    .some((alt) => alternativeAffects(version, alt, patchedVersions));
}

/**
 * Advisories that write their fixed version as an unnamed patch ("16.3.?"),
 * with the version that fixes them, read from vercel/next.js's own release
 * notes. Without an entry, "16.3.?" stays unreadable as an upper bound (the
 * check fails) and ignored as a patched version (the version stays flagged),
 * so an unnamed patch is never taken as "safe" by itself.
 *
 * Every entry below: release v16.3.8 (2026-09-30), whose notes list all seven
 * as fixed in it. Only the 16.3 line is recorded; the 15.5 line is not ours.
 */
const FIXED_IN = {
  "GHSA-cjq9-62q9-8jv4": { 16.3: "16.3.8" },
  "GHSA-f87g-xv8r-7p7x": { 16.3: "16.3.8" },
  "GHSA-3w37-wq28-93x7": { 16.3: "16.3.8" },
  "GHSA-h694-7cp9-m8p3": { 16.3: "16.3.8" },
  "GHSA-4jqv-mc3x-m676": { 16.3: "16.3.8" },
  "GHSA-mcj8-r9mp-w47p": { 16.3: "16.3.8" },
  "GHSA-39w2-rjm5-chcv": { 16.3: "16.3.8" },
};

/** Replace "major.minor.?" with the recorded fix for that line, where there is one. */
function nameUnnamedPatches(text, ghsaId) {
  if (typeof text !== "string") return text;
  const fixes = FIXED_IN[ghsaId] ?? {};
  return text.replace(
    /(\d+)\.(\d+)\.\?/g,
    (unnamed, major, minor) => fixes[`${major}.${minor}`] ?? unnamed,
  );
}

/** The published, not withdrawn, advisories that affect `next` at `version`. */
export function affecting(version, advisories) {
  return advisories.filter(
    (advisory) =>
      advisory.state === "published" &&
      !advisory.withdrawn_at &&
      (advisory.vulnerabilities ?? []).some(
        (v) =>
          v.package?.name === "next" &&
          typeof v.vulnerable_version_range === "string" &&
          inRange(
            version,
            nameUnnamedPatches(v.vulnerable_version_range, advisory.ghsa_id),
            nameUnnamedPatches(v.patched_versions, advisory.ghsa_id),
          ),
      ),
  );
}

/** Every advisory on vercel/next.js, following pages. `fetchImpl` is injectable for tests. */
export async function fetchAdvisories(token, fetchImpl = fetch) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetchImpl(
      `https://api.github.com/repos/vercel/next.js/security-advisories?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) throw new Error(`GitHub answered ${response.status} for the advisory list`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error("the advisory list was not a list");
    all.push(...batch);
    if (batch.length < 100) return all;
  }
  throw new Error("more than 1000 advisories; raise the page limit");
}

/**
 * The whole check, returning an exit code. Everything it touches outside
 * itself is passed in, so every branch can be tested without the network.
 */
export async function run({
  token,
  packageJson,
  fetchImpl = fetch,
  log = console.log,
  error = console.error,
}) {
  if (!token) {
    error("next-advisories: no GITHUB_TOKEN or GH_TOKEN; cannot read the advisories");
    return 1;
  }
  const version = packageJson?.dependencies?.next;
  if (typeof version !== "string") {
    error("next-advisories: no exact next version in package.json dependencies");
    return 1;
  }

  let hits;
  try {
    hits = affecting(version, await fetchAdvisories(token, fetchImpl));
  } catch (cause) {
    error(`next-advisories: could not check: ${cause.message}`);
    return 1;
  }
  if (hits.length > 0) {
    error(`next-advisories: next ${version} is affected by:`);
    for (const a of hits) error(`  ${a.ghsa_id} (${a.severity}) ${a.summary}`);
    return 1;
  }
  log(`next-advisories: next ${version} is outside every published Next.js advisory.`);
  return 0;
}

// Only runs when executed directly, so the checks stay importable by tests.
// exitCode rather than exit(): exiting with a fetch still closing crashes Node on Windows.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  run({ token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN, packageJson }).then((code) => {
    process.exitCode = code;
  });
}
