import { describe, it, expect } from "vitest";
import { isIndexable, isPubliclyConfigured, SITE, type SitePlaceholders } from "./site";

/**
 * Indexing is one of the few mistakes here that is genuinely hard to undo:
 * once a staging domain or placeholder content is in a search or answer
 * engine's index, removing it is slow and never complete. So the conditions
 * are tested exhaustively rather than assumed.
 */
const CONFIGURED: SitePlaceholders = {
  ...SITE,
  companyName: "Example Company",
  legalEntityName: "Example Company FZ-LLC",
  domain: "example.ae",
};

describe("isIndexable", () => {
  it("allows indexing only in production with a real identity", () => {
    expect(isIndexable("production", CONFIGURED)).toBe(true);
  });

  it("refuses staging even when the identity is real", () => {
    // The whole point: staging runs on a throwaway host domain and must never
    // compete with the real domain in an index.
    expect(isIndexable("staging", CONFIGURED)).toBe(false);
  });

  it("refuses development", () => {
    expect(isIndexable("development", CONFIGURED)).toBe(false);
  });

  it("refuses production while identity is still placeholder", () => {
    expect(isIndexable("production", SITE)).toBe(false);
    expect(isIndexable("production", { ...CONFIGURED, companyName: null })).toBe(false);
    expect(isIndexable("production", { ...CONFIGURED, domain: null })).toBe(false);
    expect(isIndexable("production", { ...CONFIGURED, legalEntityName: null })).toBe(false);
  });

  it("is false for every environment under the current real configuration", () => {
    // Guards the live state: nothing about this repository is indexable today.
    for (const env of ["development", "staging", "production"] as const) {
      expect(isIndexable(env), env).toBe(false);
    }
  });

  it("is strictly stronger than isPubliclyConfigured", () => {
    // A configured identity alone must never be sufficient - that was the bug.
    expect(isPubliclyConfigured(CONFIGURED)).toBe(true);
    expect(isIndexable("staging", CONFIGURED)).toBe(false);
  });
});
