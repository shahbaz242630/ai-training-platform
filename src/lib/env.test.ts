import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * Environment parsing, and one bug in particular.
 *
 * `.env` files are full of `KEY=` lines waiting to be filled in. Those arrive
 * as an empty string, which Zod reads as "present" - so `.optional()` never
 * applies and any format check on it fails. The failure then surfaces wherever
 * the environment is first read, which is nowhere near the blank line that
 * caused it. This actually happened: a blank sender address broke the booking
 * form and reported itself as "lead capture failed".
 */

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

async function freshServerEnv() {
  // serverEnv caches after the first read, so the module is reset per test.
  vi.resetModules();
  const loaded = await import("./env");
  return loaded.serverEnv() as Record<string, unknown>;
}

describe("serverEnv", () => {
  it("treats a blank optional variable as absent rather than invalid", async () => {
    process.env.MS_CALENDAR_USER_ID = "";
    const env = await freshServerEnv();
    expect(env.MS_CALENDAR_USER_ID).toBeUndefined();
  });

  it("still rejects a value that is present and genuinely wrong", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "not a url";
    await expect(freshServerEnv()).rejects.toThrow(/NEXT_PUBLIC_SITE_URL/);
  });

  it("accepts a real value", async () => {
    process.env.MS_CALENDAR_USER_ID = "booking@example.com";
    const env = await freshServerEnv();
    expect(env.MS_CALENDAR_USER_ID).toBe("booking@example.com");
  });

  it("treats every blank optional variable as absent, not only the mailbox", async () => {
    process.env.DATABASE_URL = "";
    process.env.STRIPE_SECRET_KEY = "";
    process.env.MS_CLIENT_SECRET = "";
    const env = await freshServerEnv();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.STRIPE_SECRET_KEY).toBeUndefined();
    expect(env.MS_CLIENT_SECRET).toBeUndefined();
  });
});

/*
  The request gate's own settings (audit s101 #21). They are read on their own
  and never throw: the gate runs on every request, and one bad value elsewhere
  must not take every page down with it.
*/
describe("gateSettings", () => {
  async function freshGate() {
    vi.resetModules();
    return (await import("./env")).gateSettings();
  }

  it("still answers when another setting is invalid", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = "https://example.test";
    process.env.HEARTBEAT_URL = "not a url at all";
    process.env.ORIGIN_SECRET = "s".repeat(40);
    expect((await freshGate()).originSecret).toBe("s".repeat(40));
  });

  it("treats a secret too short to be safe as unset, so the site stays open", async () => {
    process.env.ORIGIN_SECRET = "short";
    expect((await freshGate()).originSecret).toBeNull();
  });

  it("is off when nothing is set", async () => {
    delete process.env.ORIGIN_SECRET;
    expect((await freshGate()).originSecret).toBeNull();
  });
});
