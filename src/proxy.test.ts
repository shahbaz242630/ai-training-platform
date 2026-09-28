import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { cspFor, NONCE_PATH_PREFIX, scriptSrcFor } from "@/config/content-security-policy.mjs";

vi.mock("@/lib/env", () => ({ serverEnv: () => ({ NODE_ENV: "production" }) }));
const { proxy, config } = await import("./proxy");

/*
  The booking pages' per-request nonce (security audit and scans, 2026-09-27/28).
  `script-src 'unsafe-inline'` let any injected inline script run; with a nonce,
  only scripts carrying this request's value do.
*/
const scriptSrcOf = (policy: string) =>
  policy.split("; ").find((d) => d.startsWith("script-src")) ?? "";

describe("the policy with a nonce", () => {
  it("allows only scripts carrying the nonce, and never inline ones", () => {
    const script = scriptSrcOf(cspFor("production", "abc123"));
    expect(script).toBe("script-src 'self' 'nonce-abc123' 'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it("adds eval in development only", () => {
    expect(scriptSrcFor("development", "n")).toContain("'unsafe-eval'");
    for (const env of ["production", "test", "", undefined]) {
      expect(scriptSrcFor(env, "n")).not.toContain("'unsafe-eval'");
    }
  });

  it("changes nothing but script-src", () => {
    const withNonce = cspFor("production", "n")
      .split("; ")
      .filter((d) => !d.startsWith("script-src"));
    const without = cspFor("production")
      .split("; ")
      .filter((d) => !d.startsWith("script-src"));
    expect(withNonce).toEqual(without);
  });
});

describe("proxy", () => {
  const request = () => new NextRequest("https://example.test/training/book/ai-foundations");

  it("sends a policy naming a nonce, and hands the same nonce to the page", () => {
    const response = proxy(request());
    const policy = response.headers.get("Content-Security-Policy") ?? "";
    const nonce = /'nonce-([A-Za-z0-9+/=]+)'/.exec(policy)?.[1];

    expect(nonce).toBeTruthy();
    expect(scriptSrcOf(policy)).not.toContain("'unsafe-inline'");
    // Next.js reads the request headers it is given to put the nonce on its scripts.
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(response.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
  });

  it("uses a different nonce on every request", () => {
    const nonces = new Set(
      Array.from({ length: 50 }, () => proxy(request()).headers.get("Content-Security-Policy")),
    );
    expect(nonces.size).toBe(50);
  });

  it("runs on exactly the paths next.config.mjs leaves without a policy", () => {
    expect(config.matcher.map((m) => m.source)).toEqual([`${NONCE_PATH_PREFIX}:path*`]);
  });
});
