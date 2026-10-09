import { describe, expect, it } from "vitest";
import { TERMS_VERSION } from "@/config/booking-terms";
import { termsPdfFor, termsPdfName } from "./terms-pdfs";

describe("the printed terms", () => {
  it("exist for the terms version customers agree to today", () => {
    // Bumping TERMS_VERSION without printing the new terms would send the old ones.
    const pdf = termsPdfFor(TERMS_VERSION);
    expect(pdf).not.toBeNull();
    const bytes = Buffer.from(pdf ?? "", "base64");
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // A real document, not a stub: the printed terms run to several pages.
    expect(bytes.length).toBeGreaterThan(50_000);
  });

  it("are not invented for a version that was never printed", () => {
    expect(termsPdfFor("2026-09-27")).toBeNull();
    expect(termsPdfFor("toString")).toBeNull();
  });

  it("have a name that says what they are and which version", () => {
    expect(termsPdfName("2026-10-08")).toBe("Zaaheen-Knowledge-Centre-Terms-2026-10-08.pdf");
  });
});
