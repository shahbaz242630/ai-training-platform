import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { cspFor, NONCE_PATH_PREFIX, scriptSrcFor } from "@/config/content-security-policy.mjs";

const state = vi.hoisted(() => ({ originSecret: undefined as string | undefined }));
vi.mock("@/lib/env", () => ({
  gateSettings: () => ({ nodeEnv: "production", originSecret: state.originSecret ?? null }),
}));
const { proxy, config, needsNonce, ORIGIN_HEADER } = await import("./proxy");

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
    expect(script).toBe(
      "script-src 'self' 'nonce-abc123' 'strict-dynamic' https://challenges.cloudflare.com",
    );
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it("adds eval in development only", () => {
    expect(scriptSrcFor("development", "n")).toContain("'unsafe-eval'");
    for (const env of ["production", "test", "", undefined]) {
      expect(scriptSrcFor(env, "n")).not.toContain("'unsafe-eval'");
    }
  });

  it("changes nothing but script-src and the person check's frame", () => {
    const withNonce = cspFor("production", "n")
      .split("; ")
      .filter((d) => !d.startsWith("script-src") && !d.startsWith("frame-src"));
    const without = cspFor("production")
      .split("; ")
      .filter((d) => !d.startsWith("script-src"));
    expect(withNonce).toEqual(without);
  });

  /*
    The person check at checkout start (audit s101 #3) loads Cloudflare's
    script and shows its frame. Allowed on the booking pages only; every other
    page still allows no frame from anywhere but itself.
  */
  it("allows the person check's script and frame on the booking pages only", () => {
    const withNonce = cspFor("production", "n").split("; ");
    expect(withNonce).toContain("frame-src https://challenges.cloudflare.com");
    expect(scriptSrcOf(cspFor("production", "n"))).toBe(
      "script-src 'self' 'nonce-n' 'strict-dynamic' https://challenges.cloudflare.com",
    );
    const without = cspFor("production");
    expect(without).not.toContain("challenges.cloudflare.com");
    expect(without).not.toContain("frame-src");
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

  it("gives a nonce only to a booking page being rendered, not a prefetch or another page", () => {
    const at = (path: string, headers: Record<string, string> = {}) =>
      new NextRequest(`https://example.test${path}`, { headers });
    expect(needsNonce(at(`${NONCE_PATH_PREFIX}ai-foundations`))).toBe(true);
    expect(needsNonce(at("/training"))).toBe(false);
    expect(needsNonce(at(`${NONCE_PATH_PREFIX}x`, { "next-router-prefetch": "1" }))).toBe(false);
    expect(needsNonce(at(`${NONCE_PATH_PREFIX}x`, { purpose: "prefetch" }))).toBe(false);
    // Any other page passes straight through, with no policy from here.
    expect(proxy(at("/training")).headers.get("Content-Security-Policy")).toBeNull();
  });

  it("runs on every request but the build's static files", () => {
    const pattern = new RegExp("^" + config.matcher[0] + "$");
    expect(pattern.test("/training")).toBe(true);
    expect(pattern.test("/api/webhooks/stripe")).toBe(true);
    expect(pattern.test("/_next/static/chunks/app.js")).toBe(false);
  });
});

/*
  Only through Cloudflare (audit s101 #21): a request sent straight to the host
  skips Cloudflare's limits and rules. With the secret set, it is refused.
*/
describe("requests that did not come through Cloudflare", () => {
  const SECRET = "s".repeat(40);
  const at = (headers: Record<string, string> = {}) =>
    new NextRequest("https://example.test/training", { headers });

  it("are refused once the secret is set, whatever is presented instead", () => {
    state.originSecret = SECRET;
    try {
      const refused = proxy(at());
      expect(refused.status).toBe(403);
      // Never cached, so no cache in front can hand it to a real visitor.
      expect(refused.headers.get("Cache-Control")).toBe("no-store, private");
      expect(proxy(at({ [ORIGIN_HEADER]: "wrong" })).status).toBe(403);
      expect(proxy(at({ [ORIGIN_HEADER]: `${SECRET}x` })).status).toBe(403);
    } finally {
      state.originSecret = undefined;
    }
  });

  it("pass with the secret, which the app then never sees", () => {
    state.originSecret = SECRET;
    try {
      const response = proxy(at({ [ORIGIN_HEADER]: SECRET }));
      expect(response.status).toBe(200);
      expect(response.headers.get(`x-middleware-request-${ORIGIN_HEADER}`)).toBeNull();
    } finally {
      state.originSecret = undefined;
    }
  });

  it("are not checked at all while no secret is set", () => {
    expect(proxy(at()).status).toBe(200);
  });
});
