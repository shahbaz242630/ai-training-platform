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
  MS_MAIL_SENDER_ID: "" as string,
}));

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({
    MS_TENANT_ID: env.MS_TENANT_ID || undefined,
    MS_CLIENT_ID: env.MS_CLIENT_ID || undefined,
    MS_CLIENT_SECRET: env.MS_CLIENT_SECRET || undefined,
    MS_CALENDAR_USER_ID: env.MS_CALENDAR_USER_ID || undefined,
    MS_MAIL_SENDER_ID: env.MS_MAIL_SENDER_ID || undefined,
  }),
}));

/** Captures what the adapter asks Graph for, so the sending mailbox is observable. */
const graph = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("@/lib/microsoft-graph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/microsoft-graph")>()),
  sharedGraphClient: () => graph,
}));

import { emailIsConfigured, getEmailProvider } from "./factory";
import { GraphEmailProvider } from "./graph-provider";
import { EmailNotConfiguredError } from "./provider";

function configure() {
  env.MS_TENANT_ID = "tenant";
  env.MS_CLIENT_ID = "client";
  env.MS_CLIENT_SECRET = "secret";
  env.MS_CALENDAR_USER_ID = "diary@example.com";
  env.MS_MAIL_SENDER_ID = "desk@example.com";
}

afterEach(() => {
  env.MS_TENANT_ID = "";
  env.MS_CLIENT_ID = "";
  env.MS_CLIENT_SECRET = "";
  env.MS_CALENDAR_USER_ID = "";
  env.MS_MAIL_SENDER_ID = "";
  graph.request.mockReset();
});

describe("getEmailProvider", () => {
  it("throws when the registration is incomplete, naming what is missing", () => {
    env.MS_MAIL_SENDER_ID = "desk@example.com";
    expect(() => getEmailProvider()).toThrow(EmailNotConfiguredError);
    expect(() => getEmailProvider()).toThrow(/MS_CLIENT_SECRET/);
  });

  it("throws when the sending mailbox is missing, naming it", () => {
    configure();
    env.MS_MAIL_SENDER_ID = "";
    expect(() => getEmailProvider()).toThrow(/MS_MAIL_SENDER_ID/);
  });

  it("never sends from the calendar's mailbox in place of a missing sender", () => {
    configure();
    env.MS_MAIL_SENDER_ID = "";
    expect(() => getEmailProvider()).toThrow(EmailNotConfiguredError);
  });

  it("never falls back to the mock: the Graph adapter or nothing", () => {
    configure();
    expect(getEmailProvider()).toBeInstanceOf(GraphEmailProvider);
  });

  it("sends from the sending mailbox, not the calendar's", async () => {
    configure();
    graph.request.mockResolvedValue({ status: 202, body: null });
    await getEmailProvider().send({
      to: "customer@example.com",
      subject: "s",
      html: "<p>h</p>",
      text: "h",
      idempotencyKey: "k",
    });
    const path = graph.request.mock.calls[0]?.[0]?.path as string;
    expect(path).toBe("/users/desk%40example.com/sendMail");
    expect(path).not.toContain("diary");
  });
});

describe("emailIsConfigured", () => {
  it("is true only with the registration and the sending mailbox", () => {
    expect(emailIsConfigured()).toBe(false);
    configure();
    expect(emailIsConfigured()).toBe(true);
    env.MS_MAIL_SENDER_ID = "";
    expect(emailIsConfigured()).toBe(false);
  });

  it("does not depend on the calendar's mailbox", () => {
    configure();
    env.MS_CALENDAR_USER_ID = "";
    expect(emailIsConfigured()).toBe(true);
  });
});
