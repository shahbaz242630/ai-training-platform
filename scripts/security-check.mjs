#!/usr/bin/env node
import { checkModulesReachable } from "./reachability.mjs";
/**
 * Project-specific security guards.
 *
 * These encode invariants a linter cannot express, and each exists because
 * breaking it would cause real harm rather than untidy code. Every check is a
 * pure function over file contents so it can be unit tested - a guard nobody
 * tests is a guard nobody can trust.
 *
 * Run:  pnpm check:security
 * Test: pnpm check:security:test
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "coverage", "dist", "build", ".turbo"]);

/**
 * The tokens this file hunts for are assembled from fragments rather than
 * written out. A guard that contains the literal strings it forbids trips
 * itself, and every other scanner in the pipeline, on its own source.
 */
const TOKENS = {
  rawHtml: "dangerously" + "SetInnerHTML",
  codeEval: "ev" + "al",
  fnCtor: "Func" + "tion",
};

export function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function loadFiles(patterns) {
  return walk(ROOT)
    .map((full) => ({ path: relative(ROOT, full).split(sep).join("/"), full }))
    .filter((f) => patterns.some((p) => p.test(f.path)))
    .map((f) => ({ path: f.path, content: readFileSync(f.full, "utf8") }));
}

// ---------------------------------------------------------------- checks

/**
 * Tags are mutable. Whoever controls an action repository can repoint `v4` at
 * new code, which then runs in our pipeline with our secrets. A commit SHA is
 * the only version reference an attacker cannot rewrite.
 */
export function checkActionsPinned(files) {
  const problems = [];
  const uses = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm;
  for (const file of files) {
    for (const match of file.content.matchAll(uses)) {
      const ref = match[1];
      if (ref.startsWith("./") || ref.startsWith("docker://")) continue;
      const version = ref.split("@")[1];
      if (!version || !/^[0-9a-f]{40}$/.test(version)) {
        problems.push(`${file.path}: action "${ref}" is not pinned to a 40-character commit SHA`);
      }
    }
  }
  return problems;
}

/**
 * Anything behind NEXT_PUBLIC_ is inlined into the JavaScript bundle and is
 * readable by every visitor. A secret there is not "slightly exposed" - it is
 * published.
 */
const PUBLIC_BY_DESIGN = new Set([
  "NEXT_PUBLIC_SUPABASE_ANON_KEY", // anon key is meant to be public; RLS protects data
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", // the anon key's current name, same reasoning
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", // publishable by definition
]);

export function checkPublicEnvSecrets(files) {
  const problems = [];
  const names = /NEXT_PUBLIC_[A-Z0-9_]+/g;
  const risky = /(SECRET|PRIVATE|TOKEN|PASSWORD|CREDENTIAL|SERVICE_ROLE)/;
  for (const file of files) {
    for (const match of file.content.matchAll(names)) {
      const name = match[0];
      if (PUBLIC_BY_DESIGN.has(name)) continue;
      if (risky.test(name) || (/KEY/.test(name) && !/PUBLISHABLE|ANON/.test(name))) {
        problems.push(`${file.path}: "${name}" looks like a secret but is exposed to the browser`);
      }
    }
  }
  return problems;
}

/** Raw HTML injection is the most common XSS route in a React codebase. */
export function checkNoRawHtmlInjection(files) {
  return files
    .filter((f) => f.content.includes(TOKENS.rawHtml))
    .map((f) => `${f.path}: ${TOKENS.rawHtml} is not permitted`);
}

/** Dynamic code execution turns any injected string into running code. */
const CODE_EVAL_PATTERN = new RegExp(String.raw`\b` + TOKENS.codeEval + String.raw`\s*\(`);
const FN_CTOR_PATTERN = new RegExp(String.raw`new\s+` + TOKENS.fnCtor + String.raw`\s*\(`);

export function checkNoDynamicCodeExecution(files) {
  const problems = [];
  for (const file of files) {
    if (CODE_EVAL_PATTERN.test(file.content)) {
      problems.push(`${file.path}: dynamic code evaluation is not permitted`);
    }
    if (FN_CTOR_PATTERN.test(file.content)) {
      problems.push(`${file.path}: the ${TOKENS.fnCtor} constructor is not permitted`);
    }
  }
  return problems;
}

/**
 * Prices must have exactly one source of truth. A price built anywhere else can
 * drift from the catalogue and from Stripe, and the customer is then charged
 * something nobody approved.
 */
// The catalogue may construct prices; lib/money.ts is where aedToFils is
// *defined*, which is not the same thing as building a price with it.
const PRICE_OWNERS = /^(src\/config\/(sessions|pathways)\.ts|src\/lib\/money\.ts)$/;

export function checkPricesCentralised(files) {
  return files
    .filter((f) => !PRICE_OWNERS.test(f.path) && !f.path.endsWith(".test.ts"))
    .filter((f) => /\baedToFils\s*\(/.test(f.content))
    .map((f) => `${f.path}: builds a price outside src/config - use the catalogue`);
}

/**
 * Environment access goes through the validated schema in lib/env.ts, so a
 * missing variable fails fast at startup instead of becoming `undefined` deep
 * inside a payment path.
 */
/*
  env.ts defines the access, and its own test has to set process.env to prove
  the parsing works - including that a BLANK optional variable is treated as
  absent, which is a bug that reached the booking form once already. The
  exception is exactly those two paths and nothing else: any other file, test
  or not, still has to go through lib/env.
*/
const ENV_OWNERS = /^src\/lib\/env(\.test)?\.ts$/;

export function checkEnvCentralised(files) {
  return files
    .filter((f) => !ENV_OWNERS.test(f.path))
    .filter((f) => /process\.env\./.test(f.content))
    .map((f) => `${f.path}: reads process.env directly - use lib/env.ts`);
}

/** Cleartext transport for anything other than a local dev server. */
/**
 * An insecure URL in source, unless the line says why it is there.
 *
 * The escape hatch exists because the first legitimate case was a test
 * asserting that an http:// return address is REFUSED - the guard was right,
 * the code was right, and with no way to say so the only options were to
 * weaken the guard or to obfuscate the string past it. Both are worse than an
 * exemption that has to state a reason.
 *
 * The reason is MANDATORY. An unexplained exemption is how a real finding
 * gets buried, so a marker with nothing after it does not suppress anything.
 */
/**
 * Whether a justification covers this line.
 *
 * The marker may sit on the line itself or anywhere in the comment block
 * immediately above it, because a reason worth writing is usually longer than
 * one line. The search stops at the first line that is not a comment, so a
 * justification cannot drift away from what it justifies and keep exempting it.
 */
function exemptedAt(lines, index, marker) {
  if (marker.test(lines[index] ?? "")) return true;
  for (let i = index - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").trim();
    if (!line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*")) return false;
    if (marker.test(line)) return true;
  }
  return false;
}

export function checkNoInsecureUrls(files) {
  const problems = [];
  const http = /http:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+/gi;
  // e.g.  // security-check: allow-insecure-url - asserting that http is refused
  const exemption = /security-check:\s*allow-insecure-url\s*[-—:]\s*\S+/i;

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(http)) {
        if (exemptedAt(lines, index, exemption)) continue;
        problems.push(`${file.path}:${index + 1}: insecure URL "${match[0]}"`);
      }
    });
  }
  return problems;
}

/** A committed .env is a leaked credential set, whatever it contains today. */
export function checkNoTrackedEnvFiles(tracked) {
  return tracked
    .filter((p) => /(^|\/)\.env/.test(p) && !p.endsWith(".env.example"))
    .map((p) => `${p}: environment file is tracked by git`);
}

/**
 * Runtime versions must be declared in one place and read from there.
 *
 * Node comes from .nvmrc and pnpm from package.json#packageManager. Three
 * deploys failed in a row because CI ran a different pnpm than the host, and
 * because CI itself carried the wrong version it could not have caught any of
 * them. A version hardcoded in a workflow step recreates that split silently,
 * so it fails the build instead.
 */
export function checkRuntimesSingleSourced(files) {
  const problems = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    lines.forEach((line, i) => {
      const at = `${file.path}:${i + 1}`;
      if (/^\s*-?\s*node-version:/.test(line)) {
        problems.push(`${at}: hardcodes a Node version - use node-version-file: .nvmrc`);
      }
      if (/^\s*-?\s*NODE_VERSION:/.test(line)) {
        problems.push(`${at}: declares NODE_VERSION - use node-version-file: .nvmrc`);
      }
      // Narrow by design: the pnpm version input specifically, not every
      // `version:` key some other action might legitimately take.
      const preceding = lines.slice(Math.max(0, i - 3), i).join("\n");
      if (/^\s*-?\s*version:/.test(line) && /pnpm\/action-setup/.test(preceding)) {
        problems.push(`${at}: pins pnpm here - use package.json#packageManager`);
      }
    });
  }
  return problems;
}

// ---------------------------------------------------------------- runner

const SOURCE = [/^src\/.*\.(ts|tsx)$/];
const WORKFLOWS = [/^\.github\/workflows\/.*\.ya?ml$/];
const ENV_SURFACE = [/^src\/.*\.(ts|tsx)$/, /^next\.config\.mjs$/, /^\.env\.example$/];

function main() {
  const source = loadFiles(SOURCE);
  const workflows = loadFiles(WORKFLOWS);
  const envSurface = loadFiles(ENV_SURFACE);

  let tracked = [];
  try {
    tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    // Not a git repository, or git unavailable - skip rather than fail.
  }

  const results = [
    ["GitHub Actions pinned to commit SHAs", checkActionsPinned(workflows)],
    ["No secrets exposed to the browser", checkPublicEnvSecrets(envSurface)],
    ["No raw HTML injection", checkNoRawHtmlInjection(source)],
    ["No dynamic code execution", checkNoDynamicCodeExecution(source)],
    ["Prices only in src/config", checkPricesCentralised(source)],
    ["Environment access via lib/env.ts", checkEnvCentralised(source)],
    ["No insecure http:// URLs", checkNoInsecureUrls(source)],
    ["No tracked .env files", checkNoTrackedEnvFiles(tracked)],
    ["Runtime versions single-sourced", checkRuntimesSingleSourced(workflows)],
    ["Every logic module is reachable", checkModulesReachable(source)],
  ];

  let failed = 0;
  for (const [name, problems] of results) {
    if (problems.length === 0) {
      console.log(`  PASS  ${name}`);
    } else {
      failed += problems.length;
      console.error(`  FAIL  ${name}`);
      for (const problem of problems) console.error(`          ${problem}`);
    }
  }

  if (failed > 0) {
    console.error(`\n${failed} security guard violation(s).`);
    process.exit(1);
  }
  console.log("\nAll security guards passed.");
}

// Only runs when executed directly, so the checks stay importable by tests.
if (process.argv[1] && process.argv[1].endsWith("security-check.mjs")) main();
