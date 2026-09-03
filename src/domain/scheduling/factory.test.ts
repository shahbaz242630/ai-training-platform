import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogSink, setLogSink, type LogRecord } from "@/lib/logger";

const env = vi.hoisted(() => ({
  MS_TENANT_ID: undefined as string | undefined,
  MS_CLIENT_ID: undefined as string | undefined,
  MS_CLIENT_SECRET: undefined as string | undefined,
  MS_CALENDAR_USER_ID: undefined as string | undefined,
  NEXT_PUBLIC_SITE_ENV: "development" as "development" | "staging" | "production",
}));

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ ...env }),
  get clientEnv() {
    return {
      NEXT_PUBLIC_SITE_ENV: env.NEXT_PUBLIC_SITE_ENV,
      NEXT_PUBLIC_SITE_URL: "http://localhost:3000",
    };
  },
}));

import {
  SchedulingNotConfiguredError,
  calendarIsConfigured,
  getSchedulingProvider,
  resetSchedulingProvider,
} from "./factory";
import { GraphSchedulingProvider } from "./graph-provider";
import { MockSchedulingProvider } from "./mock-provider";

let logs: LogRecord[];

beforeEach(() => {
  resetSchedulingProvider();
  env.MS_TENANT_ID = undefined;
  env.MS_CLIENT_ID = undefined;
  env.MS_CLIENT_SECRET = undefined;
  env.MS_CALENDAR_USER_ID = undefined;
  env.NEXT_PUBLIC_SITE_ENV = "development";
  logs = [];
  setLogSink((r) => {
    logs.push(r);
  });
});

afterEach(() => {
  resetLogSink();
  resetSchedulingProvider();
});

function configure() {
  env.MS_TENANT_ID = "tenant";
  env.MS_CLIENT_ID = "client";
  env.MS_CLIENT_SECRET = "secret";
  env.MS_CALENDAR_USER_ID = "booking@example.com";
}

describe("getSchedulingProvider", () => {
  it("uses the real calendar when all four Microsoft values exist", () => {
    configure();
    expect(getSchedulingProvider()).toBeInstanceOf(GraphSchedulingProvider);
    expect(logs).toEqual([]);
  });

  it("refuses in production when any value is missing, rather than pretending", () => {
    configure();
    env.MS_CALENDAR_USER_ID = undefined;
    env.NEXT_PUBLIC_SITE_ENV = "production";
    expect(() => getSchedulingProvider()).toThrow(SchedulingNotConfiguredError);
  });

  it("falls back to the in-memory calendar outside production, and says so", () => {
    for (const siteEnv of ["development", "staging"] as const) {
      resetSchedulingProvider();
      logs = [];
      env.NEXT_PUBLIC_SITE_ENV = siteEnv;
      expect(getSchedulingProvider(), siteEnv).toBeInstanceOf(MockSchedulingProvider);
      expect(logs.some((l) => l.level === "warn" && l.message.includes("not configured"))).toBe(
        true,
      );
    }
  });

  it("hands out one shared instance, so the token cache survives across requests", () => {
    configure();
    const first = getSchedulingProvider();
    expect(getSchedulingProvider()).toBe(first);
    resetSchedulingProvider();
    expect(getSchedulingProvider()).not.toBe(first);
  });
});

describe("calendarIsConfigured", () => {
  it("needs the registration and the mailbox", () => {
    expect(calendarIsConfigured()).toBe(false);
    configure();
    expect(calendarIsConfigured()).toBe(true);
    env.MS_CALENDAR_USER_ID = undefined;
    expect(calendarIsConfigured()).toBe(false);
  });
});
