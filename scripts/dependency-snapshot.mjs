#!/usr/bin/env node
/**
 * Tell GitHub's dependency graph which packages this app really uses.
 *
 * Why this exists (security audit s101, #20): pnpm 11 writes pnpm-lock.yaml as
 * two YAML documents, pnpm's own install first and the app's dependencies
 * second. GitHub reads only the first, so the dependency graph listed 19
 * packages of pnpm itself and none of ours, and Dependabot never raised an
 * alert for Next.js, Stripe, pg or anything else we ship. This reads the app's
 * document and submits it through GitHub's dependency submission API, so the
 * alerts cover what we actually run.
 *
 *   node scripts/dependency-snapshot.mjs     (in the workflow; needs GITHUB_TOKEN)
 *
 * It refuses rather than guesses: no app document, no packages, or a package
 * line it cannot read all fail the run. A snapshot that silently lists nothing
 * is the failure being fixed.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MANIFEST = "pnpm-lock.yaml";
const LOCKFILE_VERSION = "9.0";

// A package line under `packages:`: two spaces, then name@version, quoted when
// the name is scoped. The version is a plain semver; anything else (a git or
// tarball source) is refused, so it can never drop out of the list unseen.
const PACKAGE_LINE =
  /^ {2}'?((?:@[^@\s'/]+\/)?[^@\s'/]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)'?:$/;

/** The documents of a multi-document YAML file. */
function documents(text) {
  return text
    .replace(/\r\n/g, "\n")
    .split(/^---[ \t]*$/m)
    .filter((doc) => /^lockfileVersion:/m.test(doc));
}

/** The app's document is the one whose root importer lists dependencies. */
function isAppDocument(doc) {
  const root = /^importers:\n\n? {2}\.:\n((?: {4}.*\n|\n)*)/m.exec(doc);
  return (
    root !== null && /^ {4}(?:dependencies|devDependencies|optionalDependencies):$/m.test(root[1])
  );
}

/** The lines of one top-level section ("packages:", "importers:"), up to the next. */
function section(doc, name) {
  const start = doc.search(new RegExp(`^${name}:$`, "m"));
  if (start === -1) return [];
  const lines = doc.slice(start).split("\n").slice(1);
  const end = lines.findIndex((line) => /^\S/.test(line));
  return end === -1 ? lines : lines.slice(0, end);
}

/** name@version -> "runtime" | "development", for the root importer's own dependencies. */
function directDependencies(doc) {
  const direct = new Map();
  let group = null;
  let name = null;
  let inRoot = false;
  for (const line of section(doc, "importers")) {
    if (/^ {2}\S/.test(line)) {
      inRoot = line === "  .:";
      continue;
    }
    if (!inRoot) continue;
    const groupMatch = /^ {4}(\w+):$/.exec(line);
    if (groupMatch) {
      group = groupMatch[1];
      continue;
    }
    const nameMatch = /^ {6}'?([^':]+)'?:$/.exec(line);
    if (nameMatch) {
      name = nameMatch[1];
      continue;
    }
    const versionMatch = /^ {8}version: (\S+)$/.exec(line);
    if (versionMatch && name) {
      // "16.4.1(react@19.3.0)": the peer suffix is not part of the version.
      const key = `${name}@${versionMatch[1].replace(/\(.*$/, "")}`;
      const scope = group === "devDependencies" ? "development" : "runtime";
      // Both a dependency and a dev dependency: runtime wins.
      if (direct.get(key) !== "runtime") direct.set(key, scope);
    }
  }
  return direct;
}

/** The app's packages and its direct dependencies, read from pnpm-lock.yaml's text. */
export function parseLockfile(text) {
  const apps = documents(text).filter(isAppDocument);
  if (apps.length === 0) throw new Error("no app document in the lockfile");
  if (apps.length > 1) throw new Error(`${apps.length} app documents in the lockfile`);
  const doc = apps[0];
  // The line-based reading below is written for this format. A new one must be
  // looked at by a person, not read as if it were the old one.
  const format = /^lockfileVersion: '?([^'\s]+)'?$/m.exec(doc)?.[1];
  if (format !== LOCKFILE_VERSION) {
    throw new Error(`lockfileVersion '${format}' is not '${LOCKFILE_VERSION}'; check the parser`);
  }

  const packages = [];
  for (const line of section(doc, "packages")) {
    if (!/^ {2}\S/.test(line)) continue;
    const match = PACKAGE_LINE.exec(line);
    if (!match) throw new Error(`cannot read package line: ${line.trim()}`);
    packages.push({ name: match[1], version: match[2] });
  }
  if (packages.length === 0) throw new Error("no packages in the app document");

  // Every direct dependency must be one of the packages: a miss means the
  // importer was misread (or is a link or alias this does not handle), and
  // the direct/development split would be wrong without anyone being told.
  const direct = directDependencies(doc);
  if (direct.size === 0) throw new Error("no direct dependencies read from the root importer");
  const keys = new Set(packages.map((p) => `${p.name}@${p.version}`));
  for (const key of direct.keys()) {
    if (!keys.has(key)) throw new Error(`direct dependency ${key} is not among the packages`);
  }
  return { packages, direct };
}

/**
 * The package URL the API expects; a scope's "@" is encoded as in its own
 * example, and the version is percent-encoded as the purl spec requires (a
 * build-metadata "+" becomes %2B; "-" and "." are left as they are).
 */
export function packageUrl(name, version) {
  return `pkg:npm/${name.replace(/^@/, "%40")}@${encodeURIComponent(version)}`;
}

/** The snapshot body for POST /repos/{owner}/{repo}/dependency-graph/snapshots. */
export function buildSnapshot({ packages, direct }, env, now = () => new Date()) {
  for (const key of [
    "GITHUB_REPOSITORY",
    "GITHUB_SHA",
    "GITHUB_REF",
    "GITHUB_RUN_ID",
    "GITHUB_WORKFLOW",
    "GITHUB_JOB",
  ]) {
    if (!env[key]) throw new Error(`${key} is not set; run this inside the workflow`);
  }
  const resolved = {};
  for (const { name, version } of packages) {
    const key = `${name}@${version}`;
    const scope = direct.get(key);
    resolved[key] = {
      package_url: packageUrl(name, version),
      relationship: scope ? "direct" : "indirect",
      // Unknown for indirect packages without walking the graph; runtime can
      // never hide an alert, so it is the safe answer.
      scope: scope ?? "runtime",
      dependencies: [],
    };
  }
  const server = env.GITHUB_SERVER_URL ?? "https://github.com";
  return {
    version: 0,
    sha: env.GITHUB_SHA,
    ref: env.GITHUB_REF,
    // The same correlator every run, so each snapshot replaces the one before.
    job: {
      correlator: `${env.GITHUB_WORKFLOW} ${env.GITHUB_JOB}`,
      id: env.GITHUB_RUN_ID,
      html_url: `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    },
    detector: {
      name: "dependency-snapshot.mjs",
      version: "1",
      url: `${server}/${env.GITHUB_REPOSITORY}/blob/main/scripts/dependency-snapshot.mjs`,
    },
    scanned: now().toISOString(),
    manifests: {
      [MANIFEST]: { name: MANIFEST, file: { source_location: MANIFEST }, resolved },
    },
  };
}

/** Read, build, submit. Returns the exit code; never throws. */
export async function run({
  env,
  lockText,
  fetchImpl = fetch,
  log = console.log,
  error = console.error,
  now,
}) {
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (!token) {
    error("dependency-snapshot: no GITHUB_TOKEN or GH_TOKEN; cannot submit");
    return 1;
  }
  let snapshot;
  try {
    snapshot = buildSnapshot(parseLockfile(lockText), env, now);
  } catch (cause) {
    error(`dependency-snapshot: could not read the lockfile: ${cause.message}`);
    return 1;
  }
  const count = Object.keys(snapshot.manifests[MANIFEST].resolved).length;
  try {
    const response = await fetchImpl(
      `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/dependency-graph/snapshots`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(snapshot),
      },
    );
    const body = await response.json().catch(() => ({}));
    if (response.status !== 201) {
      error(
        `dependency-snapshot: GitHub answered ${response.status}: ${body.message ?? "no message"}`,
      );
      return 1;
    }
    // SUCCESS = processed, ACCEPTED = queued for processing; anything else is a refusal.
    if (body.result !== "SUCCESS" && body.result !== "ACCEPTED") {
      error(
        `dependency-snapshot: GitHub did not take the snapshot: ${body.result ?? "no result"} ${body.message ?? ""}`,
      );
      return 1;
    }
    log(
      `dependency-snapshot: submitted ${count} packages; GitHub: ${body.result} ${body.message ?? ""}`,
    );
    return 0;
  } catch (cause) {
    error(`dependency-snapshot: could not submit: ${cause.message}`);
    return 1;
  }
}

// Only runs when executed directly, so the functions stay importable by tests.
// exitCode rather than exit(): exiting with a fetch still closing crashes Node on Windows.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const lockText = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  run({ env: process.env, lockText }).then((code) => {
    process.exitCode = code;
  });
}
