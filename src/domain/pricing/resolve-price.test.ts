import { describe, it, expect } from "vitest";
import { resolvePrice, PriceResolutionError } from "./resolve-price";
import { SESSIONS } from "@/config/sessions";
import { PATHWAYS, pathwayStandardPriceFils, pathwaySessions } from "@/config/pathways";
import { aedToFils, formatAed } from "@/lib/money";

describe("resolvePrice", () => {
  it("resolves every active session to its configured price", () => {
    for (const session of SESSIONS.filter((s) => s.active)) {
      const resolved = resolvePrice("session", session.slug);
      expect(resolved.amountFils).toBe(session.priceFils);
      expect(resolved.currency).toBe("AED");
      expect(resolved.taxTreatment).toBe("inclusive");
    }
  });

  it("matches the prices approved in the BRD", () => {
    const expected: Record<string, number> = {
      "ai-research-prompting-foundations": 1299,
      "chatgpt-codex-openai": 1499,
      "claude-claude-code": 1499,
      "ai-agents": 1699,
      "ai-builder-tech-stack": 1899,
      "production-ai-deployment": 2499,
    };
    for (const [slug, aed] of Object.entries(expected)) {
      expect(resolvePrice("session", slug).amountFils).toBe(aedToFils(aed));
    }
  });

  it("rejects an unknown slug rather than defaulting to a price", () => {
    expect(() => resolvePrice("session", "does-not-exist")).toThrow(PriceResolutionError);
  });

  it("refuses to sell an inactive pathway (v1 sells single sessions only)", () => {
    for (const pathway of PATHWAYS) {
      expect(() => resolvePrice("pathway", pathway.slug)).toThrow(PriceResolutionError);
    }
  });
});

describe("session catalogue integrity", () => {
  it("has six sessions with unique codes and slugs", () => {
    expect(SESSIONS).toHaveLength(6);
    expect(new Set(SESSIONS.map((s) => s.code)).size).toBe(6);
    expect(new Set(SESSIONS.map((s) => s.slug)).size).toBe(6);
  });

  it("prices increase with complexity across the ladder", () => {
    const ordered = [...SESSIONS].sort((a, b) => a.displayOrder - b.displayOrder);
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i]!.priceFils).toBeGreaterThanOrEqual(ordered[i - 1]!.priceFils);
    }
  });

  it("marks Session 6 as implementation with a prerequisite note", () => {
    const s6 = SESSIONS.find((s) => s.code === "S6")!;
    expect(s6.category).toBe("implementation");
    expect(s6.prerequisites).toContain("ai-builder-tech-stack");
    expect(s6.prerequisiteNote).toBeTruthy();
  });

  it("uses no banned certification vocabulary in customer-facing copy", () => {
    // This language would imply certification we do not issue.
    const banned = /\b(certificat\w*|diploma|accredit\w*|qualification|academy|institute)\b/i;
    for (const s of SESSIONS) {
      const copy = [s.title, s.summary, s.outcome, s.audience, ...s.topics].join(" ");
      expect(copy, `banned wording in ${s.code}`).not.toMatch(banned);
    }
  });
});

describe("pathways", () => {
  it("each pathway is exactly two real sessions", () => {
    for (const pathway of PATHWAYS) {
      expect(pathway.sessionSlugs).toHaveLength(2);
      expect(pathwaySessions(pathway)).toHaveLength(2);
    }
  });

  it("is always cheaper than buying both sessions separately", () => {
    for (const pathway of PATHWAYS) {
      expect(pathway.pathwayPriceFils).toBeLessThan(pathwayStandardPriceFils(pathway));
    }
  });

  it("keeps the discount within the 8-12% band the BRD allows", () => {
    for (const pathway of PATHWAYS) {
      const standard = pathwayStandardPriceFils(pathway);
      const discountPct = ((standard - pathway.pathwayPriceFils) / standard) * 100;
      expect(discountPct, pathway.slug).toBeGreaterThanOrEqual(8);
      expect(discountPct, pathway.slug).toBeLessThanOrEqual(12);
    }
  });
});

describe("money formatting", () => {
  it("formats whole dirhams without decimals", () => {
    expect(formatAed(aedToFils(1299))).toBe("AED 1,299");
  });

  it("avoids floating point drift", () => {
    expect(aedToFils(1299.99)).toBe(129999);
  });
});
