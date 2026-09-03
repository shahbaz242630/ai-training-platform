import { describe, it, expect } from "vitest";
import { isIndexable, isPubliclyConfigured, SITE, type SitePlaceholders } from "./site";

/**
 * Indexing is one of the few mistakes here that is genuinely hard to undo:
 * once a staging domain or placeholder content is in a search or answer
 * engine's index, removing it is slow and never complete. So the conditions
 * are tested exhaustively rather than assumed.
 */
/*
  Every field that renders publicly, not the obvious three. isPubliclyConfigured
  was widened on 2026-08-31 because filling in only name, domain and legal
  entity armed indexing while [SUPPORT_EMAIL] and [INSTRUCTOR_NAME] were still
  rendering on the page.
*/
const CONFIGURED: SitePlaceholders = {
  ...SITE,
  companyName: "Example Company",
  legalEntityName: "Example Company FZ-LLC",
  domain: "example.ae",
  supportEmail: "hello@example.ae",
  instructorName: "Example Instructor",
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

  it("under the current configuration, only production can index, and only once identity is real", () => {
    // Used to assert false everywhere, which pinned the placeholder state and
    // would have failed the day identity was filled in. This is the rule.
    expect(isIndexable("development")).toBe(false);
    expect(isIndexable("staging")).toBe(false);
    expect(isIndexable("production")).toBe(isPubliclyConfigured());
  });

  it("is strictly stronger than isPubliclyConfigured", () => {
    // A configured identity alone must never be sufficient - that was the bug.
    expect(isPubliclyConfigured(CONFIGURED)).toBe(true);
    expect(isIndexable("staging", CONFIGURED)).toBe(false);
  });
});
