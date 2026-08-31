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

const ENTRY_POINTS = /^src\/app\/.*\.(ts|tsx)$/;
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
  "src/domain/messaging/sending-policy.ts":
    "Phase 5 (email). Classification must exist before the first send loop does, per D38 - wiring it after would mean adding it to code that already sends.",
  "src/domain/payments/mock-provider.ts":
    "Deliberately unreachable from production and must stay so: there is no fallback to a mock when Stripe is unconfigured, because a checkout that appears to work and charges nothing is worse than an outage.",
  "src/lib/structured-data.ts":
    "C9. Blocked on real company identity and on a safe serialisation approach; emitting placeholder JSON-LD would be cached by answer engines.",
};

/** `@/x`, `./x`, `../x` - the three forms this codebase uses. */
function importsIn(content) {
  const specifiers = [];
  const pattern = /(?:from|import)\s+["']([^"']+)["']/g;
  for (const match of content.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier.startsWith("@/") || specifier.startsWith(".")) specifiers.push(specifier);
  }
  return specifiers;
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
