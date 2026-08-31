import { describe, it, expect } from "vitest";
import { getSessionByCode, getActiveSessions, getSessionBySlug, SESSIONS } from "./sessions";
import { getPathwayBySlug, pathwaySessions, pathwayStandardPriceFils, PATHWAYS } from "./pathways";
import { formatAed, aedToFils, filsToAed } from "@/lib/money";
import { isPubliclyConfigured, SITE } from "./site";

describe("session lookups", () => {
  it("finds a session by code and by slug", () => {
    expect(getSessionByCode("S4")?.slug).toBe("ai-agents");
    expect(getSessionBySlug("ai-agents")?.code).toBe("S4");
  });

  it("returns undefined rather than throwing on an unknown key", () => {
    expect(getSessionByCode("S9" as never)).toBeUndefined();
    expect(getSessionBySlug("nope")).toBeUndefined();
  });

  it("returns active sessions in display order", () => {
    const active = getActiveSessions();
    expect(active).toHaveLength(SESSIONS.filter((s) => s.active).length);
    const orders = active.map((s) => s.displayOrder);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });
});

describe("pathway helpers", () => {
  it("resolves both sessions of a pathway", () => {
    const pathway = getPathwayBySlug("ai-production-pathway")!;
    expect(pathwaySessions(pathway).map((s) => s.code)).toEqual(["S5", "S6"]);
  });

  it("returns undefined for an unknown pathway", () => {
    expect(getPathwayBySlug("nope")).toBeUndefined();
  });

  it("throws loudly if a pathway references a session that does not exist", () => {
    // A silent zero here would mean advertising a discount against a total that
    // was never real.
    const broken = { ...PATHWAYS[0]!, sessionSlugs: ["ghost", "ai-agents"] as const };
    expect(() => pathwayStandardPriceFils(broken)).toThrow(/unknown session/i);
    expect(() => pathwaySessions(broken)).toThrow(/unknown session/i);
  });
});

describe("money formatting", () => {
  it("shows decimals only when the amount actually has them", () => {
    expect(formatAed(aedToFils(1299))).toBe("AED 1,299");
    expect(formatAed(129950)).toBe("AED 1,299.50");
  });

  it("round-trips between dirhams and fils", () => {
    expect(filsToAed(aedToFils(2499))).toBe(2499);
  });
});

describe("isPubliclyConfigured", () => {
  it("is false while the real identity is unset", () => {
    expect(isPubliclyConfigured(SITE)).toBe(false);
  });

  it("is true only when every publicly rendered field is present", () => {
    // Every rendered field, not the obvious three - see isPubliclyConfigured.
    const full = {
      ...SITE,
      companyName: "A",
      domain: "a.ae",
      legalEntityName: "A LLC",
      supportEmail: "a@a.ae",
      instructorName: "A Person",
    };
    expect(isPubliclyConfigured(full)).toBe(true);
    expect(isPubliclyConfigured({ ...full, domain: null })).toBe(false);
  });
});
