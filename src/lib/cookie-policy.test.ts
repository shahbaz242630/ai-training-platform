import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/*
  The privacy notice promises one cookie: the booking in progress, for two
  hours. Anything else - an attribution or analytics cookie especially - needs
  the visitor's consent first under UK and EU law, and there is no consent
  banner. So exactly one file may touch the cookie jar, and it must keep its
  two-hour lifetime. A new cookie anywhere else fails here, before it ships,
  rather than after a regulator or a customer notices it.
*/
const COOKIE_FILE = "src/lib/lead-session.ts";

function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "src"], { encoding: "utf8" })
    .split("\n")
    .filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.(ts|tsx)$/.test(p));
}

describe("cookies", () => {
  it("are set in exactly one place: the booking in progress", () => {
    const touching = sourceFiles().filter((p) => {
      const text = readFileSync(p, "utf8");
      return (
        /\bcookies\s*\(/.test(text) || /document\.cookie/.test(text) || /Set-Cookie/i.test(text)
      );
    });
    expect(touching).toEqual([COOKIE_FILE]);
  });

  it("keep the booking cookie to two hours, as the privacy notice says", () => {
    const text = readFileSync(COOKIE_FILE, "utf8");
    expect(text).toMatch(/const COOKIE_NAME = "lead";/);
    expect(text).toMatch(/const MAX_AGE_SECONDS = 2 \* 60 \* 60;/);
  });

  it("never brings back the 90-day attribution cookie", () => {
    for (const p of sourceFiles()) {
      expect(readFileSync(p, "utf8"), p).not.toMatch(/["']ats["']/);
    }
  });
});
