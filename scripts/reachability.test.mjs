import { describe, it, expect } from "vitest";
import { REACHABILITY_ALLOWLIST, checkModulesReachable, reachableFrom } from "./reachability.mjs";

/**
 * The guard that would have caught four separate defects.
 *
 * Each of holdSlot, sweepExpiredHolds, domain/attribution and domain/booking
 * was above 90% coverage while being called by nothing. Coverage cannot see
 * it, because a module imported by its own test file is exercised, measured,
 * and counted. Only the import graph from real entry points can.
 */

const page = (content) => ({ path: "src/app/training/page.tsx", content });

describe("reachableFrom", () => {
  it("follows an alias import out of an entry point", () => {
    const files = [
      page('import { a } from "@/domain/thing";'),
      { path: "src/domain/thing.ts", content: "export const a = 1;" },
    ];
    expect(reachableFrom(files).has("src/domain/thing.ts")).toBe(true);
  });

  it("follows relative imports, including up a directory", () => {
    const files = [
      page('import { a } from "@/domain/one";'),
      { path: "src/domain/one.ts", content: 'import { b } from "./two";' },
      { path: "src/domain/two.ts", content: 'import { c } from "../lib/three";' },
      { path: "src/lib/three.ts", content: "export const c = 1;" },
    ];
    const reached = reachableFrom(files);
    expect(reached.has("src/domain/two.ts")).toBe(true);
    expect(reached.has("src/lib/three.ts")).toBe(true);
  });

  /*
    THE property this whole guard rests on. A module that only its own test
    imports must NOT count as reached - that is the exact shape of every
    occurrence of this defect.
  */
  it("does not count a module reached only by its own test", () => {
    const files = [
      page("export default function P() { return null; }"),
      { path: "src/domain/inert.ts", content: "export const x = 1;" },
      { path: "src/domain/inert.test.ts", content: 'import { x } from "./inert";' },
    ];
    expect(reachableFrom(files).has("src/domain/inert.ts")).toBe(false);
  });

  it("survives a cycle rather than looping forever", () => {
    const files = [
      page('import { a } from "@/domain/a";'),
      { path: "src/domain/a.ts", content: 'import { b } from "./b";' },
      { path: "src/domain/b.ts", content: 'import { a } from "./a";' },
    ];
    expect(reachableFrom(files).has("src/domain/b.ts")).toBe(true);
  });

  it("treats a route handler and a server action as entry points too", () => {
    const files = [
      { path: "src/app/api/x/route.ts", content: 'import { a } from "@/data/one";' },
      { path: "src/app/y/actions.ts", content: 'import { b } from "@/data/two";' },
      { path: "src/data/one.ts", content: "export const a = 1;" },
      { path: "src/data/two.ts", content: "export const b = 1;" },
    ];
    const reached = reachableFrom(files);
    expect(reached.has("src/data/one.ts")).toBe(true);
    expect(reached.has("src/data/two.ts")).toBe(true);
  });
});

describe("checkModulesReachable", () => {
  const entry = { path: "src/app/page.tsx", content: "export default function P() {}" };

  it("reports a governed module nothing reaches", () => {
    const problems = checkModulesReachable(
      [entry, { path: "src/domain/inert.ts", content: "export const x = 1;" }],
      {},
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("tested but never called");
  });

  it("says nothing about a module that is reached", () => {
    const files = [
      { path: "src/app/page.tsx", content: 'import { x } from "@/domain/live";' },
      { path: "src/domain/live.ts", content: "export const x = 1;" },
    ];
    expect(checkModulesReachable(files, {})).toEqual([]);
  });

  it("accepts an allowlisted module with a real reason", () => {
    const problems = checkModulesReachable(
      [entry, { path: "src/domain/later.ts", content: "export const x = 1;" }],
      { "src/domain/later.ts": "Phase 5. Built ahead of the send loop deliberately, per D38." },
    );
    expect(problems).toEqual([]);
  });

  /*
    An unexplained exemption is how a genuinely forgotten module gets filed as
    intentional - the failure this guard exists to end, not to reproduce.
  */
  it("refuses an allowlist entry with no adequate reason", () => {
    for (const reason of ["", "   ", "later", "TODO"]) {
      const problems = checkModulesReachable(
        [entry, { path: "src/domain/later.ts", content: "export const x = 1;" }],
        { "src/domain/later.ts": reason },
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("adequate reason");
    }
  });

  /*
    A stale entry silently grants an exemption nobody reviewed to whatever
    takes that path next.
  */
  it("reports an allowlist entry for a module that no longer exists", () => {
    const problems = checkModulesReachable([entry], {
      "src/domain/gone.ts": "A reason that was true once, for a file since deleted.",
    });
    expect(problems[0]).toContain("no such module exists");
  });

  it("reports an allowlist entry for a module that is now wired in", () => {
    const files = [
      { path: "src/app/page.tsx", content: 'import { x } from "@/domain/nowlive";' },
      { path: "src/domain/nowlive.ts", content: "export const x = 1;" },
    ];
    const problems = checkModulesReachable(files, {
      "src/domain/nowlive.ts": "Was deferred to a later phase and has since been wired in.",
    });
    expect(problems[0]).toContain("now reachable");
  });

  it("does not govern components or pages, only logic modules", () => {
    const files = [
      entry,
      { path: "src/components/training/Unused.tsx", content: "export const C = 1;" },
    ];
    expect(checkModulesReachable(files, {})).toEqual([]);
  });
});

/*
  The four defects this guard was written for, as they actually occurred.
  If a future change makes the walk more permissive, these fail.
*/
describe("the historical defects this guard exists to catch", () => {
  const cases = [
    ["src/data/slot-holds.ts", "a customer could pick a time never taken off the calendar"],
    ["src/domain/booking/slot-hold.ts", "abandoned holds left calendar entries forever"],
    ["src/domain/attribution/attribution.ts", "every visit was analysed and discarded"],
    ["src/domain/booking/booking.ts", "booking state moved by raw SQL around the transition table"],
  ];

  for (const [path, consequence] of cases) {
    it(`catches ${path} - ${consequence}`, () => {
      /*
        FIXED 2026-08-31. The test file used to import "./x", which resolves to
        nothing - so it never actually referenced the module it was supposed to
        be shadowing, and these four cases were duplicates of the baseline test
        with different path strings. Mutating the guard to treat test files as
        entry points - the exact regression this block claims to block - left
        all four passing.

        The import is now the real relative specifier, so each case genuinely
        reproduces its defect: a module referenced ONLY by its own test.
      */
      const moduleName = path.split("/").pop().replace(/\.ts$/, "");
      const testPath = path.replace(/\.ts$/, ".test.ts");

      const files = [
        { path: "src/app/page.tsx", content: "export default function P() {}" },
        { path, content: "export const thing = 1;" },
        { path: testPath, content: `import { thing } from "./${moduleName}";` },
      ];

      // The fixture must be real: the test file has to resolve to the module.
      expect(reachableFrom(files).has(path), "fixture must reference the module").toBe(false);
      expect(checkModulesReachable(files, {})).toHaveLength(1);
    });
  }
});

describe("the real allowlist", () => {
  // Every entry states why. Checked here so the rule holds for the committed
  // list, not only for the ones a test invents.
  it("gives every entry a written reason", () => {
    for (const [path, reason] of Object.entries(REACHABILITY_ALLOWLIST)) {
      expect(typeof reason, path).toBe("string");
      expect(reason.trim().length, path).toBeGreaterThanOrEqual(20);
    }
  });
});

/*
  The bypasses an adversarial re-audit found. Each let a genuinely dead module
  past the guard, which is the failure mode that matters most here - the guard
  exists to prevent a fifth occurrence of exactly that.
*/
describe("bypasses that used to work", () => {
  const dead = (entryContent) => [
    { path: "src/app/page.tsx", content: entryContent },
    { path: "src/domain/dead.ts", content: "export const x = 1;" },
  ];

  /*
    A type-only import is erased at compile time and contributes zero bytes to
    the bundle. A module whose only reference is a type import is dead by any
    runtime definition - and this was the cheapest bypass available, one
    keyword wide.
  */
  it("does not count a type-only import as reachability", () => {
    expect(checkModulesReachable(dead('import type { T } from "@/domain/dead";'), {})).toHaveLength(
      1,
    );
    expect(checkModulesReachable(dead('export type { T } from "@/domain/dead";'), {})).toHaveLength(
      1,
    );
  });

  // A commented-out import is not a reference. Counting it is a false negative
  // on precisely the shape this guard exists to catch: looks wired, is not.
  it("does not count a commented-out import", () => {
    expect(checkModulesReachable(dead('// import { x } from "@/domain/dead";'), {})).toHaveLength(
      1,
    );
    expect(
      checkModulesReachable(dead('/* import { x } from "@/domain/dead"; */'), {}),
    ).toHaveLength(1);
    expect(
      checkModulesReachable(dead('const a = 1; // import { x } from "@/domain/dead";'), {}),
    ).toHaveLength(1);
  });

  /*
    Treating every file under src/app as an entry point meant an orphan helper
    dropped there laundered everything it imported as reached, permanently and
    silently.
  */
  it("does not let a non-route file under src/app launder its imports", () => {
    const files = [
      { path: "src/app/orphan-helper.ts", content: 'import { x } from "@/domain/dead";' },
      { path: "src/domain/dead.ts", content: "export const x = 1;" },
    ];
    expect(checkModulesReachable(files, {})).toHaveLength(1);
  });

  // The narrowing must not break real routes.
  it("still treats real Next route files as entry points", () => {
    for (const entry of [
      "src/app/page.tsx",
      "src/app/layout.tsx",
      "src/app/api/x/route.ts",
      "src/app/training/book/[slug]/actions.ts",
      "src/app/robots.ts",
      "src/app/sitemap.ts",
    ]) {
      const files = [
        { path: entry, content: 'import { x } from "@/domain/live";' },
        { path: "src/domain/live.ts", content: "export const x = 1;" },
      ];
      expect(checkModulesReachable(files, {}), entry).toEqual([]);
    }
  });

  // A real value import must still resolve, or the guard is useless noise.
  it("still counts an ordinary import", () => {
    const files = [
      { path: "src/app/page.tsx", content: 'import { x } from "@/domain/live";' },
      { path: "src/domain/live.ts", content: "export const x = 1;" },
    ];
    expect(checkModulesReachable(files, {})).toEqual([]);
  });
});
