import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { cspFor, NONCE_PATH_PREFIX } from "@/config/content-security-policy.mjs";
import { gateSettings } from "@/lib/env";

/**
 * Three jobs on every page request.
 *
 * 1. ONLY THROUGH CLOUDFLARE (audit s101 #21). The host answers anybody who
 *    finds its address, and a request sent straight to it skips Cloudflare's
 *    rate limits, bot rules and the forwarded-for clean-up the limits rely on.
 *    Cloudflare adds a secret header to every request it passes on; with
 *    ORIGIN_SECRET set, a request without it is refused. Unset (staging, a
 *    laptop, the first deploy), nothing is checked. The header is removed
 *    before the app sees the request.
 *
 * 2. STAGING ONLY FOR US (audit s104 OUT-1). With STAGING_PASSWORD set, every
 *    page asks for it (HTTP Basic), except the two callers that carry their
 *    own proof (callerHasOwnProof). Staging writes the real calendar.
 *
 * 3. A NONCE FOR THE BOOKING PAGES (security audit and scans, 2026-09-27/28).
 *    `script-src 'unsafe-inline'` would let any injected inline script run.
 *    With a nonce, only scripts carrying it run: Next.js reads the nonce from
 *    the request's Content-Security-Policy header and puts it on its own
 *    scripts, and 'strict-dynamic' lets the chunks they load run too. An
 *    injected script cannot know a value that changes on every request. The
 *    booking pages are rendered per request already, which a nonce requires.
 *    next.config.mjs sends these paths every other security header but no
 *    policy of its own, so the response carries exactly this one. That holds
 *    for every request under the prefix, a prefetch included (audit s101 I1):
 *    links into the booking pages never prefetch (lib/link-prefetch.ts), and
 *    a response with no policy at all would be the weaker outcome.
 */

/** The header Cloudflare's request rule sets. Lower case, as Headers reads it. */
export const ORIGIN_HEADER = "x-zaaheen-origin";

export function proxy(request: NextRequest): NextResponse {
  // Only the two values this needs: a bad setting elsewhere must not take every page down.
  const env = gateSettings();
  if (env.originSecret && !sameSecret(request.headers.get(ORIGIN_HEADER), env.originSecret)) {
    /*
      Nothing about why: a stranger at the host's address learns only "no".
      Never cached: a cache in front of the app must not hand this to a real
      visitor arriving through Cloudflare.
    */
    return new NextResponse("Forbidden", {
      status: 403,
      headers: { "Cache-Control": "no-store, private" },
    });
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(ORIGIN_HEADER);

  if (env.staging.kind !== "off" && !callerHasOwnProof(request)) {
    const password = env.staging.kind === "on" ? env.staging.password : null;
    if (password === null || !sameSecret(basicPassword(request), password)) {
      return new NextResponse("This site is private.", {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Basic realm="Zaaheen staging", charset="UTF-8"',
          "Cache-Control": "no-store, private",
        },
      });
    }
    // The page never needs it, and nothing downstream should log it.
    requestHeaders.delete("authorization");
  }

  let policy: string | null = null;
  if (needsNonce(request)) {
    const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
    policy = cspFor(env.nodeEnv, nonce);
    requestHeaders.set("x-nonce", nonce);
    requestHeaders.set("Content-Security-Policy", policy);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  if (policy !== null) response.headers.set("Content-Security-Policy", policy);
  if (env.staging.kind !== "off") {
    /*
      A prerendered page says s-maxage, which lets a shared cache keep an
      answer given to a request carrying a password (RFC 9111 3.5). Hostinger's
      CDN sits in front of staging and would then hand it to anybody without
      asking us. Next keeps a Cache-Control that is already set.
    */
    response.headers.set("Cache-Control", "private, no-store");
    response.headers.set("Vary", "Authorization");
  }
  return response;
}

/** Any request for a booking page, a prefetch included. */
export function needsNonce(request: NextRequest): boolean {
  return request.nextUrl.pathname.startsWith(NONCE_PATH_PREFIX);
}

/**
 * Callers the staging lock lets through: Stripe's webhook (signed by Stripe)
 * and the jobs' cron routes (their own bearer secret, in the same
 * Authorization header a password would need). Neither can type a password.
 */
export function callerHasOwnProof(request: NextRequest): boolean {
  const path = request.nextUrl.pathname;
  return path === "/api/webhooks/stripe" || path.startsWith("/api/cron/");
}

/** The password from an HTTP Basic header; the user name is not checked. */
export function basicPassword(request: NextRequest): string | null {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(request.headers.get("authorization") ?? "");
  const encoded = match?.[1];
  if (encoded === undefined) return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  return colon < 0 ? null : decoded.slice(colon + 1);
}

/** Compared in constant time, so the secret cannot be found a byte at a time. */
function sameSecret(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const config = {
  // Every request but the build's static files and images, which are public anyway.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
