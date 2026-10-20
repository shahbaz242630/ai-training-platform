import { describe, expect, it } from "vitest";
import {
  PAGES,
  checkHeaders,
  hasTurnstileKey,
  nonceOf,
  probeOrigin,
  run,
} from "./live-headers.mjs";

/**
 * The live header check, offline: no test makes a network call. Each case is
 * a way the CDN in front of the app has changed, or could change, what a
 * browser receives.
 */

const STATIC = PAGES.find((p) => !p.nonce);
const BOOKING = PAGES.find((p) => p.nonce);

const GOOD = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-embedder-policy": "credentialless",
  "x-permitted-cross-domain-policies": "none",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

const STATIC_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; object-src 'none'; base-uri 'self', upgrade-insecure-requests";
const nonceCsp = (nonce) =>
  `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'; frame-ancestors 'none'; object-src 'none'; base-uri 'self', upgrade-insecure-requests`;

const getter = (headers) => (name) => headers[name] ?? null;

describe("checkHeaders", () => {
  it("passes the headers the live site sends today, Hostinger's extra policy included", () => {
    expect(
      checkHeaders(STATIC, getter({ ...GOOD, "content-security-policy": STATIC_CSP })),
    ).toEqual([]);
    expect(
      checkHeaders(BOOKING, getter({ ...GOOD, "content-security-policy": nonceCsp("abc=") })),
    ).toEqual([]);
  });

  it("catches a policy replaced by the CDN's own, as happened on staging", () => {
    const problems = checkHeaders(
      BOOKING,
      getter({ ...GOOD, "content-security-policy": "upgrade-insecure-requests" }),
    );
    expect(problems.join("\n")).toMatch(/lacks frame-ancestors 'none'/);
    expect(problems.join("\n")).toMatch(/script-src has no nonce/);
  });

  it("catches a booking page allowed inline scripts", () => {
    const csp = nonceCsp("abc=").replace("'strict-dynamic'", "'strict-dynamic' 'unsafe-inline'");
    const problems = checkHeaders(BOOKING, getter({ ...GOOD, "content-security-policy": csp }));
    expect(problems).toEqual([
      `${BOOKING.path}: script-src allows 'unsafe-inline' on a booking page`,
    ]);
  });

  it("catches a missing or weakened header", () => {
    const headers = { ...GOOD, "content-security-policy": STATIC_CSP };
    delete headers["x-frame-options"];
    headers["strict-transport-security"] = "max-age=300";
    const problems = checkHeaders(STATIC, getter(headers));
    expect(problems.join("\n")).toMatch(/x-frame-options is "null"/);
    expect(problems.join("\n")).toMatch(/strict-transport-security is "max-age=300"/);
  });
});

describe("run", () => {
  const response = (status, headers) => ({ status, headers: { get: getter(headers) } });

  it("asks for a fresh nonce twice and fails when the same one comes back: the page is cached", async () => {
    const fetchImpl = (url) =>
      Promise.resolve(
        url.endsWith(BOOKING.path)
          ? response(200, { ...GOOD, "content-security-policy": nonceCsp("same=") })
          : response(200, { ...GOOD, "content-security-policy": STATIC_CSP }),
      );
    const errors = [];
    const code = await run({
      base: "https://live.example/",
      fetchImpl,
      log: () => undefined,
      error: (m) => errors.push(m),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/same nonce came back twice/);
  });

  it("passes when every page is right and each request gets its own nonce", async () => {
    let n = 0;
    const fetchImpl = (url) => {
      n += 1;
      return Promise.resolve(
        url.endsWith(BOOKING.path)
          ? response(200, { ...GOOD, "content-security-policy": nonceCsp(`n${n}=`) })
          : response(200, { ...GOOD, "content-security-policy": STATIC_CSP }),
      );
    };
    const logs = [];
    expect(await run({ base: "https://live.example", fetchImpl, log: (m) => logs.push(m) })).toBe(
      0,
    );
    expect(logs[0]).toMatch(/all present/);
  });

  it("fails a page that does not answer 200", async () => {
    const fetchImpl = () => Promise.resolve(response(503, {}));
    const errors = [];
    const code = await run({
      base: "https://live.example",
      fetchImpl,
      error: (m) => errors.push(m),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/status 503/);
  });

  it("fails when the second request for a booking page does not answer 200", async () => {
    let bookingCalls = 0;
    const fetchImpl = (url) => {
      if (!url.endsWith(BOOKING.path)) {
        return Promise.resolve(response(200, { ...GOOD, "content-security-policy": STATIC_CSP }));
      }
      bookingCalls += 1;
      return Promise.resolve(
        bookingCalls === 1
          ? response(200, { ...GOOD, "content-security-policy": nonceCsp("first=") })
          : response(502, {}),
      );
    };
    const errors = [];
    const code = await run({
      base: "https://live.example",
      fetchImpl,
      error: (m) => errors.push(m),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/status 502 on the second request/);
  });

  it("reads the nonce out of a policy", () => {
    expect(nonceOf(nonceCsp("xyz="))).toBe("xyz=");
    expect(nonceOf(STATIC_CSP)).toBeNull();
    expect(nonceOf(null)).toBeNull();
  });
});

/*
  The two protections that are on only while a host setting is set (audit
  s104 COA-3): losing the setting switches them off with no other sign.
*/
describe("the switch-off checks", () => {
  const page = (status, headers, body = "") => ({
    status,
    headers: { get: getter(headers) },
    text: () => Promise.resolve(body),
  });
  let n = 0;
  const site = (bookingBody) => (url) => {
    n += 1;
    return Promise.resolve(
      url.endsWith(BOOKING.path)
        ? page(200, { ...GOOD, "content-security-policy": nonceCsp(`k${n}=`) }, bookingBody)
        : page(200, { ...GOOD, "content-security-policy": STATIC_CSP }),
    );
  };
  const KEYED = 'self.__next_f.push([1,"{\\"turnstileSiteKey\\":\\"0x4AAAAAAAexampleKey01\\"}"])';
  const quiet = { log: () => undefined, error: () => undefined };

  it("finds the person check's key in the page data, and not a missing one", () => {
    expect(hasTurnstileKey(KEYED)).toBe(true);
    expect(hasTurnstileKey('{"turnstileSiteKey":"0x4AAAAAAAexampleKey01"}')).toBe(true);
    expect(hasTurnstileKey('{\\"turnstileSiteKey\\":null}')).toBe(false);
    expect(hasTurnstileKey("")).toBe(false);
  });

  it("fails a booking page with no key while the check is expected", async () => {
    const errors = [];
    const code = await run({
      base: "https://live.example",
      fetchImpl: site('{\\"turnstileSiteKey\\":null}'),
      expectTurnstile: true,
      ...quiet,
      error: (m) => errors.push(m),
    });
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/no person-check key/);
  });

  it("passes with the key, and does not read the page when the check is not expected", async () => {
    expect(
      await run({
        base: "https://live.example",
        fetchImpl: site(KEYED),
        expectTurnstile: true,
        ...quiet,
      }),
    ).toBe(0);
    expect(await run({ base: "https://live.example", fetchImpl: site(""), ...quiet })).toBe(0);
  });

  it("fails unless a request straight to the host is refused with 403", async () => {
    for (const status of [200, 404, null, "no answer (ETIMEDOUT)"]) {
      const errors = [];
      const code = await run({
        base: "https://live.example",
        fetchImpl: site(""),
        originProbe: () => Promise.resolve(status),
        ...quiet,
        error: (m) => errors.push(m),
      });
      expect(code, String(status)).toBe(1);
      expect(errors.join("\n")).toMatch(/straight to the host/);
      // Why, when there was no answer: a timeout and a refusal mean different things.
      expect(errors.join("\n")).toContain(`status ${status ?? "no answer"},`);
    }
    expect(
      await run({
        base: "https://live.example",
        fetchImpl: site(""),
        originProbe: () => Promise.resolve(403),
        ...quiet,
      }),
    ).toBe(0);
  });
});

describe("probeOrigin", () => {
  // Loopback only, to a port nothing listens on: no network call leaves the machine.
  it("says why there was no answer, never the address", async () => {
    const status = await probeOrigin("127.0.0.1", "localhost", "/training", 1);
    expect(status).toMatch(/^no answer \(E[A-Z]+\)$/);
    expect(String(status)).not.toContain("127.0.0.1");
  });
});
