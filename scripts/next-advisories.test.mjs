import { describe, it, expect } from "vitest";
import { affecting, compareVersions, fetchAdvisories, inRange, run } from "./next-advisories.mjs";

/*
  The check that reads vercel/next.js's own advisories, because GitHub's
  reviewed database can lag them by days. These pin the range reading, since a
  range misread as "not affected" is the one failure that hides a real hole.
  No network: the advisories here are shaped like the real API's answers.
*/
const advisory = (range, extra = {}) => ({
  ghsa_id: "GHSA-test-test-test",
  severity: "critical",
  summary: "test",
  state: "published",
  withdrawn_at: null,
  vulnerabilities: [
    { package: { ecosystem: "npm", name: "next" }, vulnerable_version_range: range },
  ],
  ...extra,
});

describe("compareVersions", () => {
  it("orders by major, minor and patch numerically", () => {
    expect(compareVersions("16.3.6", "16.3.10")).toBe(-1);
    expect(compareVersions("16.10.0", "16.9.9")).toBe(1);
    expect(compareVersions("16.3.6", "16.3.6")).toBe(0);
  });

  it("puts a pre-release below its release", () => {
    expect(compareVersions("16.4.0-canary.1", "16.4.0")).toBe(-1);
  });
});

describe("inRange", () => {
  // The real range of GHSA-vcvr-r3jv-pc5j, as the API wrote it.
  it("reads the range that affected this app", () => {
    expect(inRange("16.3.3", ">= 16.2.0 < 16.3.6")).toBe(true);
    expect(inRange("16.3.6", ">= 16.2.0 < 16.3.6")).toBe(false);
    expect(inRange("16.1.9", ">= 16.2.0 < 16.3.6")).toBe(false);
  });

  it("reads ranges with no spaces, commas, and exact versions", () => {
    expect(inRange("16.3.2", "<16.3.3")).toBe(true);
    expect(inRange("1.5.0", ">= 1.0.0, < 2.0.0")).toBe(true);
    expect(inRange("15.0.0", "= 15.0.0")).toBe(true);
    expect(inRange("15.0.1", "= 15.0.0")).toBe(false);
    expect(inRange("15.0.0", "<= 15.0.0")).toBe(true);
    expect(inRange("15.0.0", "> 15.0.0")).toBe(false);
  });

  // Both found on real vercel/next.js advisories when this check first ran live.
  it("reads a bare version as where the flaw began on that release line", () => {
    expect(inRange("16.0.0", "16.0.0")).toBe(true);
    expect(inRange("16.3.6", "16.0.0")).toBe(true);
    expect(inRange("15.9.9", "16.0.0")).toBe(false);
    // Another line's entry says nothing about this one.
    expect(inRange("16.3.6", "15.0.0")).toBe(false);
  });

  it("reads versions written with a leading v", () => {
    expect(compareVersions("v16.0.7", "16.0.7")).toBe(0);
  });

  it("reads a list of lower bounds, with short versions, as where it began per line", () => {
    expect(inRange("13.3.0", ">= 13.3, >= 14, >=15, >=16")).toBe(true);
    expect(inRange("13.2.9", ">= 13.3, >= 14, >=15, >=16")).toBe(false);
  });

  // Every one of these shapes is on a real vercel/next.js advisory.
  it("reads the loose shapes real advisories use", () => {
    expect(inRange("15.1.0", "=>15.0 <15.2.3")).toBe(true);
    expect(inRange("15.1.0", ">15.0.4 and <15.2.0")).toBe(true);
    expect(inRange("15.2.0", ">15.0.4 and <15.2.0")).toBe(false);
    expect(inRange("15.3.0", "15.0.0 - 15.4.4")).toBe(true);
    expect(inRange("15.4.5", "15.0.0 - 15.4.4")).toBe(false);
    expect(inRange("9.5.2", "9.5.0 <= 9.5.3")).toBe(true);
    expect(inRange("13.9.9", "13.x")).toBe(true);
    expect(inRange("16.3.6", "13.x")).toBe(false);
    expect(inRange("15.1.0", "< 14.2.31, 15.0.0 - 15.4.4")).toBe(true);
    expect(inRange("16.3.6", "<=12.3.5, <=13.5.9, <=14.2.25, <=15.2.3")).toBe(false);
    expect(inRange("16.3.6", ">= v12.2.0 < 15.5.16")).toBe(false);
  });

  it("does not flag a newer line from an old open-ended range with no fix on that line", () => {
    expect(inRange("16.3.6", ">=10.0.0", "12.0.5")).toBe(false);
    expect(inRange("12.0.4", ">=10.0.0", "12.0.5")).toBe(true);
  });

  it("refuses a range it cannot read rather than calling it safe", () => {
    expect(() => inRange("16.3.6", "all versions")).toThrow(/unreadable/);
  });
});

describe("affecting", () => {
  it("finds an advisory whose range contains the version", () => {
    expect(affecting("16.3.3", [advisory(">= 16.2.0 < 16.3.6")])).toHaveLength(1);
  });

  it("ignores one whose range does not", () => {
    expect(affecting("16.3.6", [advisory(">= 16.2.0 < 16.3.6")])).toEqual([]);
  });

  it("checks every vulnerable range an advisory lists", () => {
    const twoMajors = advisory("", {
      vulnerabilities: [
        { package: { name: "next" }, vulnerable_version_range: ">= 10.0.0 < 15.5.24" },
        { package: { name: "next" }, vulnerable_version_range: ">= 16.0.0 < 16.3.3" },
      ],
    });
    expect(affecting("16.3.2", [twoMajors])).toHaveLength(1);
    expect(affecting("16.3.3", [twoMajors])).toEqual([]);
  });

  /*
    The shapes that only say where a flaw began, with the fix in
    patched_versions (GHSA-9g9p-9gw9-jx7f and GHSA-5j59-xgg2-r9c4, as the API
    returned them). Without the patched check both would wrongly flag 16.3.6.
  */
  it("uses patched_versions for a range that gives only where the flaw began", () => {
    const began = advisory("", {
      vulnerabilities: [
        {
          package: { name: "next" },
          vulnerable_version_range: "15.0.0",
          patched_versions: "15.5.10",
        },
        {
          package: { name: "next" },
          vulnerable_version_range: "16.0.0",
          patched_versions: "16.1.5",
        },
      ],
    });
    expect(affecting("16.1.4", [began])).toHaveLength(1);
    expect(affecting("16.1.5", [began])).toEqual([]);
    expect(affecting("16.3.6", [began])).toEqual([]);

    const perLine = advisory("", {
      vulnerabilities: [
        {
          package: { name: "next" },
          vulnerable_version_range: ">= 13.3, >= 14, >=15, >=16",
          patched_versions: "14.2.35, 15.5.9, 16.0.10, 16.1.0-canary.19",
        },
      ],
    });
    expect(affecting("16.0.9", [perLine])).toHaveLength(1);
    expect(affecting("16.3.6", [perLine])).toEqual([]);
  });

  it("does not treat a fix on another major line as fixing this one", () => {
    const fixedOnlyIn15 = advisory("", {
      vulnerabilities: [
        {
          package: { name: "next" },
          vulnerable_version_range: "16.0.0",
          patched_versions: "15.5.10",
        },
      ],
    });
    expect(affecting("16.3.6", [fixedOnlyIn15])).toHaveLength(1);
  });

  it("ignores withdrawn advisories and other packages", () => {
    expect(
      affecting("16.3.3", [advisory("< 16.3.6", { withdrawn_at: "2026-09-23T00:00:00Z" })]),
    ).toEqual([]);
    expect(
      affecting("16.3.3", [
        advisory("", {
          vulnerabilities: [
            { package: { name: "@next/font" }, vulnerable_version_range: "< 99.0.0" },
          ],
        }),
      ]),
    ).toEqual([]);
  });
});

/*
  The run itself, with GitHub replaced by a scripted fetch. The one rule that
  matters: every way of NOT knowing fails the check, exactly like being
  affected does.
*/
const answer = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});
const scriptedFetch = (answers) => {
  const urls = [];
  const impl = async (url) => {
    urls.push(url);
    const next = answers.shift();
    if (!next) throw new Error("no scripted answer left");
    return next;
  };
  return { impl, urls };
};
const quiet = () => {
  const lines = [];
  return { lines, log: (l) => lines.push(l), error: (l) => lines.push(l) };
};
const pkg = (next) => ({ dependencies: { next } });

describe("run", () => {
  it("passes when the installed version is outside every advisory", async () => {
    const out = quiet();
    const { impl } = scriptedFetch([answer(200, [advisory(">= 16.2.0 < 16.3.6")])]);
    expect(await run({ token: "t", packageJson: pkg("16.3.6"), fetchImpl: impl, ...out })).toBe(0);
    expect(out.lines.join("\n")).toContain("outside every published");
  });

  it("fails and names the advisory when the version is affected", async () => {
    const out = quiet();
    const { impl } = scriptedFetch([answer(200, [advisory(">= 16.2.0 < 16.3.6")])]);
    expect(await run({ token: "t", packageJson: pkg("16.3.3"), fetchImpl: impl, ...out })).toBe(1);
    expect(out.lines.join("\n")).toContain("GHSA-test-test-test");
  });

  it("fails without a token rather than skipping the check", async () => {
    expect(await run({ token: undefined, packageJson: pkg("16.3.6"), ...quiet() })).toBe(1);
  });

  it("fails when package.json names no exact next version", async () => {
    expect(await run({ token: "t", packageJson: { dependencies: {} }, ...quiet() })).toBe(1);
  });

  it("fails when GitHub cannot be read", async () => {
    const out = quiet();
    const { impl } = scriptedFetch([answer(503, { message: "down" })]);
    expect(await run({ token: "t", packageJson: pkg("16.3.6"), fetchImpl: impl, ...out })).toBe(1);
    expect(out.lines.join("\n")).toContain("could not check");
  });

  it("fails when an advisory range cannot be read", async () => {
    const { impl } = scriptedFetch([answer(200, [advisory("every version")])]);
    expect(await run({ token: "t", packageJson: pkg("16.3.6"), fetchImpl: impl, ...quiet() })).toBe(
      1,
    );
  });
});

describe("fetchAdvisories", () => {
  it("follows pages until a short one", async () => {
    const full = Array.from({ length: 100 }, () => advisory("< 1.0.0"));
    const { impl, urls } = scriptedFetch([answer(200, full), answer(200, [advisory("< 1.0.0")])]);
    expect(await fetchAdvisories("t", impl)).toHaveLength(101);
    expect(urls[1]).toContain("page=2");
  });

  it("refuses an answer that is not a list", async () => {
    const { impl } = scriptedFetch([answer(200, { message: "rate limited" })]);
    await expect(fetchAdvisories("t", impl)).rejects.toThrow(/not a list/);
  });

  it("stops rather than paging forever", async () => {
    const full = Array.from({ length: 100 }, () => advisory("< 1.0.0"));
    const { impl } = scriptedFetch(Array.from({ length: 10 }, () => answer(200, full)));
    await expect(fetchAdvisories("t", impl)).rejects.toThrow(/page limit/);
  });
});
