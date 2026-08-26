import { describe, it, expect } from "vitest";
import { walk } from "./security-check.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("walk", () => {
  it("finds nested files and skips ignored directories", () => {
    const root = mkdtempSync(join(tmpdir(), "walk-"));
    try {
      mkdirSync(join(root, "src", "deep"), { recursive: true });
      mkdirSync(join(root, "node_modules"), { recursive: true });
      writeFileSync(join(root, "src", "deep", "a.ts"), "");
      // If node_modules were walked, the guards would scan tens of thousands of
      // third-party files and take minutes instead of milliseconds.
      writeFileSync(join(root, "node_modules", "b.ts"), "");

      const found = walk(root).map((p) => p.replaceAll("\\", "/"));
      expect(found.some((p) => p.endsWith("src/deep/a.ts"))).toBe(true);
      expect(found.some((p) => p.includes("node_modules"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
