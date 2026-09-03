/**
 * Every logic module must be reachable from something a customer can hit.
 *
 * THIS GUARD EXISTS BECAUSE THE SAME DEFECT HAPPENED FOUR TIMES.
 *
 *   holdSlot            built, tested, called by nothing - a customer could
 *                       pick a time that was never taken off the calendar
 *   sweepExpiredHolds   built, tested, called by nothing - abandoned holds
 *                       left tentative calendar entries forever
 *   domain/attribution  built, tested, called by nothing - every visit was
 *                       analysed and then discarded
 *   domain/booking      238 lines, 27 tests, called by nothing - booking state
 *                       moved by raw SQL around the transition table
 *
 * Each was above 90% coverage while being completely inert. COVERAGE CANNOT
 * DETECT THIS: a module imported only by its own test file is exercised,
 * measured, and counted towards the threshold. Only walking the import graph
 * from the entry points a customer actually reaches will find it.
 *
 * A module may be deliberately unwired - built ahead of the phase that will
 * use it. That is fine, and it is why the allowlist exists. What is not fine
 * is being unwired by accident and nobody noticing for four phases, so every
 * allowlist entry must carry a written reason.
 */

/**
 * Real Next.js route files, not everything parked under `src/app`.
 *
 * Treating any file in that tree as an entry point meant an orphan helper
 * dropped there laundered every module it imported as "reached", permanently
 * and silently. Only files Next itself will load can confer reachability.
 */
const ENTRY_POINTS =
  /^src\/app\/(?:.*\/)?(page|layout|route|actions|template|default|loading|error|global-error|not-found|sitemap|robots|opengraph-image|icon|apple-icon|manifest|instrumentation|middleware)\.(ts|tsx)$/;
const GOVERNED = /^src\/(config|domain|data|lib)\/.*\.(ts|tsx)$/;
const IS_TEST = /\.test\.(ts|tsx)$/;

/**
 * Modules that are deliberately not wired in yet, each with the reason.
 *
 * A bare path is not accepted - see checkModulesReachable. An entry that
 * stops being true is a lie in the one place somebody looks to decide whether
 * an unwired module is intentional.
 */
export const REACHABILITY_ALLOWLIST = {
  "src/domain/messaging/mock-provider.ts":
    "Deliberately unreachable from production and must stay so: there is no fallback to a mock when email is unconfigured, because a sweep that marks messages sent into memory would record a customer as told when they were told nothing.",
  "src/domain/payments/mock-provider.ts":
    "Deliberately unreachable from production and must stay so: there is no fallback to a mock when Stripe is unconfigured, because a checkout that appears to work and charges nothing is worse than an outage.",
  "src/lib/microsoft-graph.ts":
    "Phase 4. The Graph client lands one slice before the calendar provider that calls it, so the client can be reviewed and tested on its own; the provider slice removes this entry.",
  "src/lib/structured-data.ts":
    "C9. Blocked on real company identity and on a safe serialisation approach; emitting placeholder JSON-LD would be cached by answer engines.",
};

/**
 * `@/x`, `./x`, `../x` - the three forms this codebase uses.
 *
 * TWO things are deliberately NOT counted as reachability, because neither
 * means the module runs:
 *
 *   `import type { T } from "x"`  is erased at compile time and contributes
 *                                 zero bytes to the bundle. A module whose
 *                                 only reference is a type import is dead by
 *                                 any runtime definition, and this was the
 *                                 cheapest accidental bypass available - one
 *                                 keyword wide.
 *
 *   a COMMENTED-OUT import        is not a reference at all. Counting it is a
 *                                 false negative on exactly the defect shape
 *                                 this guard exists to catch: a module that
 *                                 looks wired in and is not.
 */
function importsIn(content) {
  const specifiers = [];

  for (const rawLine of stripBlockComments(content).split(/\r?\n/)) {
    // Anything after `//` is not code. Checked per line, before matching.
    const line = rawLine.replace(/\/\/.*$/, "");

    // `import type ...` and `export type ...` are erased by the compiler.
    if (/^\s*(?:import|export)\s+type\s/.test(line)) continue;

    for (const match of line.matchAll(/(?:from|import)\s+["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier.startsWith("@/") || specifier.startsWith(".")) specifiers.push(specifier);
    }
  }

  return specifiers;
}

/** Block comments can hide a whole import, and often do in commented-out code. */
function stripBlockComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Resolve a specifier to the repo-relative module path it names, if we have it. */
function resolveSpecifier(specifier, fromPath, known) {
  let base;
  if (specifier.startsWith("@/")) {
    base = "src/" + specifier.slice(2);
  } else {
    const parts = fromPath.split("/").slice(0, -1);
    for (const segment of specifier.split("/")) {
      if (segment === ".") continue;
      else if (segment === "..") parts.pop();
      else parts.push(segment);
    }
    base = parts.join("/");
  }

  for (const candidate of [base, base + ".ts", base + ".tsx", base + "/index.ts"]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/**
 * The modules reachable by walking imports out from every entry point.
 *
 * Test files are excluded from the walk deliberately, and that exclusion IS
 * the guard. A module imported only by its own test is exactly the shape of
 * every occurrence of this defect - it looks alive to coverage and is dead to
 * customers.
 */
export function reachableFrom(files) {
  const known = new Set(files.map((f) => f.path));
  const byPath = new Map(files.map((f) => [f.path, f.content]));

  const queue = files.filter((f) => ENTRY_POINTS.test(f.path) && !IS_TEST.test(f.path));
  const reached = new Set(queue.map((f) => f.path));

  while (queue.length > 0) {
    const current = queue.pop();
    for (const specifier of importsIn(current.content)) {
      const target = resolveSpecifier(specifier, current.path, known);
      if (target === null || reached.has(target) || IS_TEST.test(target)) continue;
      reached.add(target);
      queue.push({ path: target, content: byPath.get(target) ?? "" });
    }
  }

  return reached;
}

/**
 * Report every governed module nothing can reach.
 *
 * An allowlist entry with no reason does not suppress anything: an
 * unexplained exemption is how a genuinely forgotten module gets filed as
 * intentional, which is the failure this guard exists to end rather than to
 * reproduce.
 */
export function checkModulesReachable(files, allowlist = REACHABILITY_ALLOWLIST) {
  const reached = reachableFrom(files);
  const problems = [];

  for (const file of files) {
    if (!GOVERNED.test(file.path) || IS_TEST.test(file.path)) continue;
    if (reached.has(file.path)) continue;

    const reason = allowlist[file.path];
    if (typeof reason === "string" && reason.trim().length >= 20) continue;

    problems.push(
      reason === undefined
        ? `${file.path}: no entry point reaches this module - it is tested but never called. ` +
            `Wire it in, delete it, or add it to REACHABILITY_ALLOWLIST with a written reason.`
        : `${file.path}: allowlisted without an adequate reason - say why it is not wired in yet.`,
    );
  }

  /*
    A stale allowlist is its own hazard: an entry naming a module that is now
    wired in, or that no longer exists, quietly grants an exemption nobody
    reviewed to whatever takes that path next.
  */
  for (const path of Object.keys(allowlist)) {
    const present = files.some((f) => f.path === path);
    if (!present) {
      problems.push(`${path}: allowlisted but no such module exists - remove the stale entry.`);
    } else if (reached.has(path)) {
      problems.push(`${path}: allowlisted but now reachable - remove the entry, it is wired in.`);
    }
  }

  return problems;
}
