import { describe, expect, it } from "vitest";
import { normalisePem } from "./pem";

/*
  Hostinger's environment variable box is one line. A certificate pasted into
  it loses its line breaks, and OpenSSL refuses a PEM whose BEGIN and END
  markers are not on lines of their own - so production would refuse to
  connect, with the right certificate configured.
*/
const BODY = "A".repeat(64) + "B".repeat(64) + "C".repeat(20);
const CANONICAL = [
  "-----BEGIN CERTIFICATE-----",
  "A".repeat(64),
  "B".repeat(64),
  "C".repeat(20),
  "-----END CERTIFICATE-----",
].join("\n");

describe("normalisePem", () => {
  it("leaves a well-formed certificate exactly as it is", () => {
    expect(normalisePem(CANONICAL)).toBe(CANONICAL);
  });

  it("rebuilds the lines of a certificate pasted into a one-line box", () => {
    expect(normalisePem(CANONICAL.replace(/\n/g, " "))).toBe(CANONICAL);
    expect(normalisePem(CANONICAL.replace(/\n/g, ""))).toBe(CANONICAL);
  });

  it("reads literal \\n sequences as line breaks", () => {
    expect(normalisePem(CANONICAL.replace(/\n/g, "\\n"))).toBe(CANONICAL);
  });

  it("accepts Windows line endings and surrounding whitespace", () => {
    expect(normalisePem(`  ${CANONICAL.replace(/\n/g, "\r\n")}\r\n`)).toBe(CANONICAL);
  });

  it("wraps a body at 64 characters whatever its original wrapping", () => {
    const oneLongLine = `-----BEGIN CERTIFICATE-----\n${BODY}\n-----END CERTIFICATE-----`;
    expect(normalisePem(oneLongLine)).toBe(CANONICAL);
  });

  it("keeps every certificate of a chain, in order", () => {
    const second = CANONICAL.replace(/A/g, "D");
    expect(normalisePem(`${CANONICAL} ${second.replace(/\n/g, " ")}`)).toBe(
      `${CANONICAL}\n${second}`,
    );
  });

  it("returns anything without a complete PEM block untouched, for the driver to judge", () => {
    expect(normalisePem("-----BEGIN CERTIFICATE-----")).toBe("-----BEGIN CERTIFICATE-----");
    expect(normalisePem("not a certificate")).toBe("not a certificate");
    expect(normalisePem("")).toBe("");
  });
});
