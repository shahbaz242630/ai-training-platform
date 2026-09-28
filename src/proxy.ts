import { NextResponse, type NextRequest } from "next/server";
import { cspFor } from "@/config/content-security-policy.mjs";
import { serverEnv } from "@/lib/env";

/**
 * A fresh nonce, and the policy that names it, for every booking page request
 * (security audit and scans, 2026-09-27/28).
 *
 * `script-src 'unsafe-inline'` would let any injected inline script run. With
 * a nonce, only scripts carrying it run: Next.js reads the nonce from the
 * request's Content-Security-Policy header and puts it on its own scripts, and
 * 'strict-dynamic' lets the chunks they load run too. An injected script
 * cannot know a value that changes on every request. The booking pages are
 * rendered per request already, which a nonce requires.
 *
 * next.config.mjs sends these paths every other security header but no policy
 * of its own, so the response carries exactly this one.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = cspFor(serverEnv().NODE_ENV, nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      // NONCE_PATH_PREFIX, written out: a matcher must be a literal (a test holds them equal).
      source: "/training/book/:path*",
      // Prefetches are not rendered pages and need no nonce.
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
