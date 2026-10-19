import { describe, it, expect } from "vitest";
import {
  UNKNOWN_CALLER,
  clientAddressFrom,
  isUsableReturnUrl,
  limitKeyFrom,
  networkBlock,
} from "./client-address";

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

/*
  Limits count a network, not an address. One IPv6 connection is handed a
  whole /64 block, billions of addresses, so a limit per address is no limit
  at all: one cheap server could hold every slot in the diary. IPv4 stays per
  address, since sharing (an office, a mobile network) is common there and a
  wider block would lock out strangers.
*/
describe("networkBlock", () => {
  it("keeps an IPv4 address as it is", () => {
    expect(networkBlock("203.0.113.9")).toBe("203.0.113.9");
  });

  it("counts every address in one IPv6 /64 as the same caller", () => {
    const a = networkBlock("2001:db8:abcd:12:1111:2222:3333:4444");
    const b = networkBlock("2001:db8:abcd:12::9");
    const c = networkBlock("2001:0DB8:ABCD:0012:ffff:ffff:ffff:ffff");
    expect(a).toBe("2001:db8:abcd:12::/64");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("keeps different /64 blocks apart", () => {
    expect(networkBlock("2001:db8:abcd:13::1")).not.toBe(networkBlock("2001:db8:abcd:12::1"));
  });

  it("expands :: wherever it sits", () => {
    expect(networkBlock("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(networkBlock("::1")).toBe("0:0:0:0::/64");
    expect(networkBlock("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("reads an IPv4 address carried in IPv6 as the IPv4 address", () => {
    expect(networkBlock("::ffff:203.0.113.9")).toBe("203.0.113.9");
  });

  it("leaves anything it cannot read as it is, and the shared unknown bucket alone", () => {
    expect(networkBlock(UNKNOWN_CALLER)).toBe(UNKNOWN_CALLER);
    expect(networkBlock("not-an-address")).toBe("not-an-address");
    expect(networkBlock("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
  });
});

describe("limitKeyFrom", () => {
  it("is the trusted address's network block", () => {
    expect(limitKeyFrom("198.51.100.1, 2001:db8:abcd:12:aaaa::1")).toBe("2001:db8:abcd:12::/64");
    expect(limitKeyFrom(null)).toBe(UNKNOWN_CALLER);
  });
});
