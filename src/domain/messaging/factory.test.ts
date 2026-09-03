import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The factory reads the validated environment. It is mocked per test rather
 * than set through process.env, because the environment module is parsed
 * once and memoised.
 */
const env = vi.hoisted(() => ({ RESEND_API_KEY: "", EMAIL_FROM: "" }));

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({
    RESEND_API_KEY: env.RESEND_API_KEY || undefined,
    EMAIL_FROM: env.EMAIL_FROM || undefined,
  }),
}));

import { emailIsConfigured, getEmailProvider } from "./factory";
import { EmailNotConfiguredError } from "./provider";
import { ResendEmailProvider } from "./resend-provider";

afterEach(() => {
  env.RESEND_API_KEY = "";
  env.EMAIL_FROM = "";
});

describe("getEmailProvider", () => {
  it("throws when the key is missing, naming it", () => {
    env.EMAIL_FROM = "bookings@example.com";
    expect(() => getEmailProvider()).toThrow(EmailNotConfiguredError);
    expect(() => getEmailProvider()).toThrow(/RESEND_API_KEY/);
  });

  it("throws when the sender is missing, naming it", () => {
    env.RESEND_API_KEY = "re_test";
    expect(() => getEmailProvider()).toThrow(/EMAIL_FROM/);
  });

  it("never falls back to the mock: the real adapter or nothing", () => {
    env.RESEND_API_KEY = "re_test";
    env.EMAIL_FROM = "bookings@example.com";
    expect(getEmailProvider()).toBeInstanceOf(ResendEmailProvider);
  });
});

describe("emailIsConfigured", () => {
  it("is true only with both values present", () => {
    expect(emailIsConfigured()).toBe(false);
    env.RESEND_API_KEY = "re_test";
    expect(emailIsConfigured()).toBe(false);
    env.EMAIL_FROM = "bookings@example.com";
    expect(emailIsConfigured()).toBe(true);
  });
});
