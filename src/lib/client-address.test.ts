import { describe, it, expect } from "vitest";
import { UNKNOWN_CALLER, clientAddressFrom, isUsableReturnUrl } from "./client-address";

/**
 * The rate limit is only as good as the key it counts against.
 *
 * The bug being fixed: taking the FIRST x-forwarded-for entry. The header is
 * built by appending, so the leftmost value is whatever the client wrote -
 * meaning a fresh bucket per request, which does not weaken a rate limit, it
 * removes it.
 */

describe("clientAddressFrom", () => {
  /*
    THE regression test. Everything to the left of our own proxy is attacker
    text, and it must never become the key.
  */
  it("ignores a spoofed leading entry and uses what our proxy appended", () => {
    expect(clientAddressFrom("1.1.1.1, 203.0.113.9")).toBe("203.0.113.9");
  });

  it("gives the same key however the client varies the part it controls", () => {
    const a = clientAddressFrom("9.9.9.9, 203.0.113.9");
    const b = clientAddressFrom("8.8.8.8, 203.0.113.9");
    const c = clientAddressFrom("anything at all, 203.0.113.9");
    expect(new Set([a, b, c]).size).toBe(1);
  });

  it("uses the only entry when exactly one proxy added it", () => {
    expect(clientAddressFrom("203.0.113.9")).toBe("203.0.113.9");
  });

  it("counts in from the right when more proxies are trusted", () => {
    expect(clientAddressFrom("1.1.1.1, 203.0.113.9, 10.0.0.1", 2)).toBe("203.0.113.9");
  });

  /*
    A chain shorter than expected means the request did not arrive the way we
    think. Falling back to the leftmost entry there would restore the exact
    bypass this closes, so it falls back to the shared bucket instead - an
    unknown caller is limited MORE, not less.
  */
  it("falls back to the shared bucket rather than to a forgeable entry", () => {
    expect(clientAddressFrom("1.1.1.1", 2)).toBe(UNKNOWN_CALLER);
    expect(clientAddressFrom("1.1.1.1, 2.2.2.2", 5)).toBe(UNKNOWN_CALLER);
  });

  it("falls back when the header is absent or empty", () => {
    expect(clientAddressFrom(null)).toBe(UNKNOWN_CALLER);
    expect(clientAddressFrom("")).toBe(UNKNOWN_CALLER);
    expect(clientAddressFrom("   ,  , ")).toBe(UNKNOWN_CALLER);
  });

  it("tolerates untidy spacing", () => {
    expect(clientAddressFrom("1.1.1.1,   203.0.113.9  ")).toBe("203.0.113.9");
  });

  // A count of zero or less would index past the end; it must not silently
  // become "leftmost".
  it("never reads the leftmost entry however the proxy count is abused", () => {
    expect(clientAddressFrom("1.1.1.1, 203.0.113.9", 0)).toBe("203.0.113.9");
    expect(clientAddressFrom("1.1.1.1, 203.0.113.9", -5)).toBe("203.0.113.9");
  });
});

describe("isUsableReturnUrl", () => {
  /*
    The failure this prevents: a production deploy forgets the site URL, the
    default sends paying customers back to their own machine, the payment
    succeeds and nothing reports a fault.
  */
  it("refuses localhost in production", () => {
    expect(isUsableReturnUrl("http://localhost:3000", true)).toBe(false);
    expect(isUsableReturnUrl("https://127.0.0.1", true)).toBe(false);
  });

  it("refuses plain http in production", () => {
    // security-check: allow-insecure-url - the point of this test is that an
    // http return address is refused; it is never fetched.
    expect(isUsableReturnUrl("http://example.com", true)).toBe(false);
  });

  it("accepts a real https host in production", () => {
    expect(isUsableReturnUrl("https://example.com", true)).toBe(true);
  });

  it("refuses something that is not a URL at all", () => {
    expect(isUsableReturnUrl("not a url", true)).toBe(false);
  });

  // Local development must keep working with no configuration.
  it("allows anything outside production", () => {
    expect(isUsableReturnUrl("http://localhost:3000", false)).toBe(true);
  });
});
