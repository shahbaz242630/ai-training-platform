import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { cspFor, NONCE_PATH_PREFIX } from "@/config/content-security-policy.mjs";
import { gateSettings } from "@/lib/env";

/**
 * Two jobs on every page request.
 *
 * 1. ONLY THROUGH CLOUDFLARE (audit s101 #21). The host answers anybody who
 *    finds its address, and a request sent straight to it skips Cloudflare's
 *    rate limits, bot rules and the forwarded-for clean-up the limits rely on.
 *    Cloudflare adds a secret header to every request it passes on; with
 *    ORIGIN_SECRET set, a request without it is refused. Unset (staging, a
 *    laptop, the first deploy), nothing is checked. The header is removed
 *    before the app sees the request.
 *
 * 2. A NONCE FOR THE BOOKING PAGES (security audit and scans, 2026-09-27/28).
 *    `script-src 'unsafe-inline'` would let any injected inline script run.
 *    With a nonce, only scripts carrying it run: Next.js reads the nonce from
 *    the request's Content-Security-Policy header and puts it on its own
 *    scripts, and 'strict-dynamic' lets the chunks they load run too. An
 *    injected script cannot know a value that changes on every request. The
 *    booking pages are rendered per request already, which a nonce requires.
 *    next.config.mjs sends these paths every other security header but no
 *    policy of its own, so the response carries exactly this one. Prefetches
 *    are not rendered pages and get none.
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
  if (!needsNonce(request)) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = cspFor(env.nodeEnv, nonce);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

/** A booking page being rendered, not prefetched. */
export function needsNonce(request: NextRequest): boolean {
  if (!request.nextUrl.pathname.startsWith(NONCE_PATH_PREFIX)) return false;
  if (request.headers.has("next-router-prefetch")) return false;
  return request.headers.get("purpose") !== "prefetch";
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
