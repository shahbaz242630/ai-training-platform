import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The factory reads the validated environment. It is mocked per test rather
 * than set through process.env, because the environment module is parsed
 * once and memoised.
 */
const env = vi.hoisted(() => ({
  MS_TENANT_ID: "" as string,
  MS_CLIENT_ID: "" as string,
  MS_CLIENT_SECRET: "" as string,
  MS_CALENDAR_USER_ID: "" as string,
}));

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({
    MS_TENANT_ID: env.MS_TENANT_ID || undefined,
    MS_CLIENT_ID: env.MS_CLIENT_ID || undefined,
    MS_CLIENT_SECRET: env.MS_CLIENT_SECRET || undefined,
    MS_CALENDAR_USER_ID: env.MS_CALENDAR_USER_ID || undefined,
  }),
}));

import { emailIsConfigured, getEmailProvider } from "./factory";
import { GraphEmailProvider } from "./graph-provider";
import { EmailNotConfiguredError } from "./provider";

function configure() {
  env.MS_TENANT_ID = "tenant";
  env.MS_CLIENT_ID = "client";
  env.MS_CLIENT_SECRET = "secret";
  env.MS_CALENDAR_USER_ID = "booking@example.com";
}

afterEach(() => {
  env.MS_TENANT_ID = "";
  env.MS_CLIENT_ID = "";
  env.MS_CLIENT_SECRET = "";
  env.MS_CALENDAR_USER_ID = "";
});

describe("getEmailProvider", () => {
  it("throws when the registration is incomplete, naming what is missing", () => {
    env.MS_CALENDAR_USER_ID = "booking@example.com";
    expect(() => getEmailProvider()).toThrow(EmailNotConfiguredError);
    expect(() => getEmailProvider()).toThrow(/MS_CLIENT_SECRET/);
  });

  it("throws when the mailbox is missing, naming it", () => {
    configure();
    env.MS_CALENDAR_USER_ID = "";
    expect(() => getEmailProvider()).toThrow(/MS_CALENDAR_USER_ID/);
  });

  it("never falls back to the mock: the Graph adapter or nothing", () => {
    configure();
    expect(getEmailProvider()).toBeInstanceOf(GraphEmailProvider);
  });
});

describe("emailIsConfigured", () => {
  it("is true only with the registration and the mailbox", () => {
    expect(emailIsConfigured()).toBe(false);
    configure();
    expect(emailIsConfigured()).toBe(true);
    env.MS_CALENDAR_USER_ID = "";
    expect(emailIsConfigured()).toBe(false);
  });
});
