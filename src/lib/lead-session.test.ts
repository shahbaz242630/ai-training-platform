import { afterEach, describe, it, expect, vi } from "vitest";
import { decodeLeadSession, encodeLeadSession } from "./lead-session";

/**
 * The cookie that carries who the browser said it was.
 *
 * Parsing is strict on purpose: anything that is not exactly two UUIDs is
 * discarded rather than passed along to become a database lookup on
 * attacker-chosen text.
 */

const CUSTOMER = "11111111-2222-4333-8444-555555555555";
const INTAKE = "66666666-7777-4888-8999-aaaaaaaaaaaa";

describe("lead session encoding", () => {
  it("round-trips a real pair", () => {
    const encoded = encodeLeadSession({ customerId: CUSTOMER, intakeId: INTAKE });
    expect(decodeLeadSession(encoded)).toEqual({ customerId: CUSTOMER, intakeId: INTAKE });
  });

  it("carries nothing but the two ids", () => {
    const encoded = encodeLeadSession({ customerId: CUSTOMER, intakeId: INTAKE });
    expect(encoded).toBe(`${CUSTOMER}.${INTAKE}`);
  });
});

describe("decodeLeadSession", () => {
  it("returns null when there is no cookie at all", () => {
    expect(decodeLeadSession(undefined)).toBeNull();
    expect(decodeLeadSession("")).toBeNull();
  });

  it("refuses anything that is not two parts", () => {
    expect(decodeLeadSession(CUSTOMER)).toBeNull();
    expect(decodeLeadSession(`${CUSTOMER}.${INTAKE}.${INTAKE}`)).toBeNull();
  });

  /*
    The values reach a parameterised query, so this is defence in depth rather
    than the only thing standing between us and an injection - but text a
    stranger chose should not become a lookup key in the first place.
  */
  it("refuses values that are not UUIDs", () => {
    expect(decodeLeadSession("not-a-uuid.also-not")).toBeNull();
    expect(decodeLeadSession(`${CUSTOMER}.wrong`)).toBeNull();
    expect(decodeLeadSession(`wrong.${INTAKE}`)).toBeNull();
    expect(decodeLeadSession("1' or '1'='1.2")).toBeNull();
  });

  /*
    Upper case is not the shape we issue, and accepting it widens the surface
    for no benefit. INTAKE is used here rather than CUSTOMER deliberately -
    CUSTOMER is all digits, so upper-casing it changes nothing and the test
    would pass without proving anything.
  */
  it("refuses a UUID in the wrong case", () => {
    expect(INTAKE.toUpperCase()).not.toBe(INTAKE);
    expect(decodeLeadSession(`${CUSTOMER}.${INTAKE.toUpperCase()}`)).toBeNull();
  });

  it("refuses a pair with whitespace around it", () => {
    expect(decodeLeadSession(` ${CUSTOMER}.${INTAKE}`)).toBeNull();
    expect(decodeLeadSession(`${CUSTOMER}.${INTAKE} `)).toBeNull();
  });
});

/*
  The cookie itself. next/headers is mocked because a real cookie jar needs a
  request context; what is being proven here is the FLAGS, which are the part
  that decides whether a script on the page can read somebody identity.
*/
describe("the lead cookie", () => {
  interface SetCall {
    name: string;
    value: string;
    options: Record<string, unknown>;
  }

  const setup = async (existing?: string) => {
    const calls: SetCall[] = [];
    vi.resetModules();
    vi.doMock("next/headers", () => ({
      cookies: () =>
        Promise.resolve({
          get: (name: string) => (existing === undefined ? undefined : { name, value: existing }),
          set: (name: string, value: string, options: Record<string, unknown>) =>
            calls.push({ name, value, options }),
        }),
    }));
    const mod = await import("./lead-session");
    return { mod, calls };
  };

  afterEach(() => {
    vi.doUnmock("next/headers");
  });

  /*
    httpOnly is the whole point. A value scripts cannot reach is one an
    injected script cannot harvest, and nothing on the page needs to read it.
  */
  it("writes an httpOnly, lax, path-wide cookie", async () => {
    const { mod, calls } = await setup();
    await mod.writeLeadSession({ customerId: CUSTOMER, intakeId: INTAKE }, true);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toMatchObject({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
    });
  });

  // Secure would make the cookie invisible over plain http on localhost, so
  // development is the one place it is off - and only there.
  it("drops the secure flag only outside production", async () => {
    const { mod, calls } = await setup();
    await mod.writeLeadSession({ customerId: CUSTOMER, intakeId: INTAKE }, false);

    expect(calls[0]?.options.secure).toBe(false);
  });

  it("expires rather than lasting forever", async () => {
    const { mod, calls } = await setup();
    await mod.writeLeadSession({ customerId: CUSTOMER, intakeId: INTAKE }, true);

    const maxAge = calls[0]?.options.maxAge;
    expect(typeof maxAge).toBe("number");
    expect(maxAge).toBeGreaterThan(0);
    // Booking is one sitting. A long-lived cookie hands the next person on a
    // shared machine somebody else details.
    expect(maxAge).toBeLessThanOrEqual(24 * 60 * 60);
  });

  it("reads back a cookie it wrote", async () => {
    const { mod } = await setup(`${CUSTOMER}.${INTAKE}`);
    expect(await mod.readLeadSession()).toEqual({ customerId: CUSTOMER, intakeId: INTAKE });
  });

  it("reads nothing when the cookie is absent", async () => {
    const { mod } = await setup();
    expect(await mod.readLeadSession()).toBeNull();
  });

  it("reads nothing when the cookie was tampered with", async () => {
    const { mod } = await setup("not-a-pair");
    expect(await mod.readLeadSession()).toBeNull();
  });
});
