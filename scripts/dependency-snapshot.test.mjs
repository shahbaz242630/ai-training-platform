import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { buildSnapshot, packageUrl, parseLockfile, run } from "./dependency-snapshot.mjs";

/*
  The dependency graph's view of this app (audit s101 #20). pnpm 11 writes the
  lockfile as two YAML documents, pnpm's own install first and the app second,
  and GitHub reads only the first: it saw 19 packages of pnpm itself and none of
  ours, so Dependabot never raised an alert. These pin the reading of the
  second document, because a reading that silently finds nothing is the exact
  failure being fixed. No network.
*/

const TOOL_DOC = `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 11.24.0
        version: 11.24.0

packages:

  pnpm@11.24.0:
    resolution: {integrity: sha512-x}

snapshots:

  pnpm@11.24.0: {}
`;

const APP_DOC = `---
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      '@react-email/render':
        specifier: 2.1.0
        version: 2.1.0(react-dom@19.3.0(react@19.3.0))(react@19.3.0)
      next:
        specifier: 16.4.1
        version: 16.4.1(react@19.3.0)
      react:
        specifier: 19.3.0
        version: 19.3.0
    devDependencies:
      react:
        specifier: 19.3.0
        version: 19.3.0
      vitest:
        specifier: 4.1.11
        version: 4.1.11(vite@8.2.2)

packages:

  '@react-email/render@2.1.0':
    resolution: {integrity: sha512-a}
    engines: {node: '>=18'}

  next@16.4.1:
    resolution: {integrity: sha512-b}

  react@19.3.0:
    resolution: {integrity: sha512-c}

  scheduler@0.27.0:
    resolution: {integrity: sha512-d}

  vite@8.2.2:
    resolution: {integrity: sha512-e}

  vitest@4.1.11:
    resolution: {integrity: sha512-f}

snapshots:

  next@16.4.1(react@19.3.0):
    dependencies:
      react: 19.3.0
`;

const LOCK = TOOL_DOC + APP_DOC;

const ENV = {
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_REF: "refs/heads/main",
  GITHUB_RUN_ID: "123",
  GITHUB_WORKFLOW: "Dependency graph",
  GITHUB_JOB: "submit",
  GITHUB_SERVER_URL: "https://github.com",
};

const NOW = () => new Date("2026-10-20T06:00:00.000Z");

const answer = (status, body = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe("parseLockfile", () => {
  it("reads the app's document, not pnpm's own", () => {
    const { packages } = parseLockfile(LOCK);
    const names = packages.map((p) => `${p.name}@${p.version}`);
    expect(names).toEqual([
      "@react-email/render@2.1.0",
      "next@16.4.1",
      "react@19.3.0",
      "scheduler@0.27.0",
      "vite@8.2.2",
      "vitest@4.1.11",
    ]);
    expect(names).not.toContain("pnpm@11.24.0");
  });

  it("knows the direct dependencies, with peer suffixes stripped", () => {
    const { direct } = parseLockfile(LOCK);
    expect(direct.get("next@16.4.1")).toBe("runtime");
    expect(direct.get("@react-email/render@2.1.0")).toBe("runtime");
    expect(direct.get("vitest@4.1.11")).toBe("development");
    expect(direct.has("scheduler@0.27.0")).toBe(false);
  });

  it("counts a package that is both a dependency and a dev dependency as runtime", () => {
    expect(parseLockfile(LOCK).direct.get("react@19.3.0")).toBe("runtime");
  });

  it("still works if pnpm goes back to a single document", () => {
    expect(parseLockfile(APP_DOC.replace(/^---\n/, "")).packages).toHaveLength(6);
  });

  it("refuses a lockfile with no app document", () => {
    expect(() => parseLockfile(TOOL_DOC)).toThrow(/no app document/);
  });

  it("refuses a lockfile with two app documents", () => {
    expect(() => parseLockfile(APP_DOC + APP_DOC)).toThrow(/2 app documents/);
  });

  it("refuses an app document with no packages", () => {
    const empty = APP_DOC.replace(/\npackages:[\s\S]*?\nsnapshots:/, "\nsnapshots:");
    expect(() => parseLockfile(empty)).toThrow(/no packages/);
  });

  it("refuses a package it cannot name, rather than skipping it", () => {
    const odd = APP_DOC.replace("  scheduler@0.27.0:", "  scheduler@github:owner/scheduler#abc:");
    expect(() => parseLockfile(odd)).toThrow(/cannot read package line/);
  });

  it("refuses a direct dependency that is not among the packages", () => {
    const missing = APP_DOC.replace(
      "  vitest@4.1.11:\n    resolution: {integrity: sha512-f}\n",
      "",
    );
    expect(() => parseLockfile(missing)).toThrow(/vitest@4\.1\.11 is not among the packages/);
  });

  it("refuses an app document whose direct dependencies it cannot read", () => {
    const unread = APP_DOC.replace(/^ {8}version: /gm, "         version: ");
    expect(() => parseLockfile(unread)).toThrow(/no direct dependencies/);
  });

  it("refuses a lockfile format it was not written for", () => {
    const newer = APP_DOC.replace("lockfileVersion: '9.0'", "lockfileVersion: '10.0'");
    expect(() => parseLockfile(newer)).toThrow(/lockfileVersion '10\.0'/);
  });

  it("ignores a further document that is not the app's", () => {
    expect(parseLockfile(LOCK + TOOL_DOC).packages).toHaveLength(6);
  });

  it("reads a lockfile with Windows line endings", () => {
    expect(parseLockfile(LOCK.replace(/\n/g, "\r\n")).packages).toHaveLength(6);
  });

  it("reads a scoped package with a pre-release version", () => {
    const pre = APP_DOC.replace("  scheduler@0.27.0:", "  '@scope/pre@1.0.0-beta.2':");
    const names = parseLockfile(pre).packages.map((p) => `${p.name}@${p.version}`);
    expect(names).toContain("@scope/pre@1.0.0-beta.2");
  });

  it("reads this repository's real lockfile, every package and every direct dependency", () => {
    const real = readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
    const { packages, direct } = parseLockfile(real);
    // An independent count: every package key line in the app document's packages section.
    const appDoc = real.replace(/\r\n/g, "\n").split(/^---$/m).at(-1);
    const block = appDoc.slice(appDoc.indexOf("\npackages:\n"), appDoc.indexOf("\nsnapshots:\n"));
    const keyLines = block.split("\n").filter((line) => /^ {2}\S/.test(line));
    expect(packages).toHaveLength(keyLines.length);
    expect(packages.length).toBeGreaterThan(300);
    const keys = new Set(packages.map((p) => `${p.name}@${p.version}`));
    for (const key of direct.keys()) expect(keys.has(key)).toBe(true);
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const names = new Set([...direct.keys()].map((key) => key.slice(0, key.lastIndexOf("@"))));
    for (const name of Object.keys(manifest.dependencies)) {
      expect(names.has(name)).toBe(true);
      const key = [...direct.keys()].find((k) => k.slice(0, k.lastIndexOf("@")) === name);
      expect(direct.get(key)).toBe("runtime");
    }
    for (const name of Object.keys(manifest.devDependencies)) expect(names.has(name)).toBe(true);
  });
});

describe("packageUrl", () => {
  it("encodes a scope's @ as the API's example does", () => {
    expect(packageUrl("@react-email/render", "2.1.0")).toBe("pkg:npm/%40react-email/render@2.1.0");
  });

  it("leaves an unscoped name alone", () => {
    expect(packageUrl("next", "16.4.1")).toBe("pkg:npm/next@16.4.1");
  });

  it("encodes a build-metadata + as the purl spec requires", () => {
    expect(packageUrl("x", "1.0.0+build.5")).toBe("pkg:npm/x@1.0.0%2Bbuild.5");
    expect(packageUrl("x", "1.0.0-beta.2")).toBe("pkg:npm/x@1.0.0-beta.2");
  });
});

describe("buildSnapshot", () => {
  const snapshot = buildSnapshot(parseLockfile(LOCK), ENV, NOW);

  it("ties the snapshot to the commit and branch it describes", () => {
    expect(snapshot.version).toBe(0);
    expect(snapshot.sha).toBe(ENV.GITHUB_SHA);
    expect(snapshot.ref).toBe("refs/heads/main");
    expect(snapshot.scanned).toBe("2026-10-20T06:00:00.000Z");
  });

  it("uses a correlator that stays the same from run to run, so each run replaces the last", () => {
    expect(snapshot.job.correlator).toBe("Dependency graph submit");
    expect(snapshot.job.id).toBe("123");
    expect(snapshot.job.html_url).toBe("https://github.com/owner/repo/actions/runs/123");
  });

  it("lists every package under the lockfile, direct or indirect", () => {
    const manifest = snapshot.manifests["pnpm-lock.yaml"];
    expect(manifest.file.source_location).toBe("pnpm-lock.yaml");
    const resolved = manifest.resolved;
    expect(Object.keys(resolved)).toHaveLength(6);
    expect(resolved["next@16.4.1"]).toEqual({
      package_url: "pkg:npm/next@16.4.1",
      relationship: "direct",
      scope: "runtime",
      dependencies: [],
    });
    expect(resolved["vitest@4.1.11"].scope).toBe("development");
    // Indirect packages are marked runtime: the lockfile does not say which are
    // dev-only without walking the graph, and runtime can never hide an alert.
    expect(resolved["scheduler@0.27.0"]).toMatchObject({
      relationship: "indirect",
      scope: "runtime",
    });
  });

  it("refuses to run without the workflow's context", () => {
    const partial = { ...ENV };
    delete partial.GITHUB_SHA;
    expect(() => buildSnapshot(parseLockfile(LOCK), partial, NOW)).toThrow(/GITHUB_SHA/);
  });
});

describe("run", () => {
  const quiet = () => {};

  it("submits the snapshot and reports what GitHub accepted", async () => {
    const calls = [];
    const logs = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return answer(201, {
        id: 9,
        result: "SUCCESS",
        message: "Dependency results for the repo have been successfully updated.",
      });
    };
    const code = await run({
      env: { ...ENV, GITHUB_TOKEN: "t" },
      lockText: LOCK,
      fetchImpl,
      log: (l) => logs.push(l),
      error: quiet,
      now: NOW,
    });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.github.com/repos/owner/repo/dependency-graph/snapshots");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers.Authorization).toBe("Bearer t");
    const body = JSON.parse(calls[0].init.body);
    expect(Object.keys(body.manifests["pnpm-lock.yaml"].resolved)).toHaveLength(6);
    expect(logs.join("\n")).toMatch(/6 packages.*SUCCESS/);
  });

  it("fails without a token", async () => {
    const errors = [];
    const code = await run({
      env: ENV,
      lockText: LOCK,
      fetchImpl: async () => answer(201),
      log: quiet,
      error: (l) => errors.push(l),
      now: NOW,
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/GITHUB_TOKEN/);
  });

  it("fails when GitHub refuses the snapshot", async () => {
    const errors = [];
    const code = await run({
      env: { ...ENV, GITHUB_TOKEN: "t" },
      lockText: LOCK,
      fetchImpl: async () => answer(403, { message: "Resource not accessible by integration" }),
      log: quiet,
      error: (l) => errors.push(l),
      now: NOW,
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/403.*not accessible/);
  });

  it("accepts a snapshot GitHub has queued rather than processed", async () => {
    const code = await run({
      env: { ...ENV, GITHUB_TOKEN: "t" },
      lockText: LOCK,
      fetchImpl: async () => answer(201, { result: "ACCEPTED", message: "queued" }),
      log: quiet,
      error: quiet,
      now: NOW,
    });
    expect(code).toBe(0);
  });

  it("fails when GitHub takes the request but calls the snapshot invalid", async () => {
    const code = await run({
      env: { ...ENV, GITHUB_TOKEN: "t" },
      lockText: LOCK,
      fetchImpl: async () => answer(201, { result: "INVALID", message: "bad" }),
      log: quiet,
      error: quiet,
      now: NOW,
    });
    expect(code).toBe(1);
  });

  it("fails on a 201 whose body cannot be read", async () => {
    const unreadable = {
      ok: true,
      status: 201,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    };
    const code = await run({
      env: { ...ENV, GITHUB_TOKEN: "t" },
      lockText: LOCK,
      fetchImpl: async () => unreadable,
      log: quiet,
      error: quiet,
      now: NOW,
    });
    expect(code).toBe(1);
  });

  it("fails when the network does", async () => {
    const errors = [];
    const code = await run({
      env: { ...ENV, GITHUB_TOKEN: "t" },
      lockText: LOCK,
      fetchImpl: async () => {
        throw new Error("offline");
      },
      log: quiet,
      error: (l) => errors.push(l),
      now: NOW,
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/offline/);
  });

  it("fails on an unreadable lockfile without calling GitHub", async () => {
    let called = false;
    const code = await run({
      env: { ...ENV, GITHUB_TOKEN: "t" },
      lockText: TOOL_DOC,
      fetchImpl: async () => {
        called = true;
        return answer(201);
      },
      log: quiet,
      error: quiet,
      now: NOW,
    });
    expect(code).toBe(1);
    expect(called).toBe(false);
  });
});
