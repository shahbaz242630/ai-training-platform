/*
  The Content-Security-Policy, built in one place for both routes that send it:
  next.config.mjs (every page, no nonce) and src/proxy.ts (the booking pages,
  a fresh nonce per request). Plain JavaScript so the config can import it.

  WHY THE BOOKING PAGES ARE DIFFERENT (security audit and scans, 2026-09-27/28):
  `script-src 'unsafe-inline'` lets any injected inline script run, which makes
  the policy no defence against XSS at all. The booking pages take personal
  details, record consent and hand off to Stripe, and they are already
  rendered per request, so they get a nonce instead: Next.js puts it on its
  own scripts, and 'strict-dynamic' lets the chunks those scripts load run.
  An injected script cannot know the nonce, so it does not run. The static
  pages keep 'unsafe-inline' (a nonce needs per-request rendering); they take
  no input.

  React's development build uses eval() for debugging, so development adds
  'unsafe-eval'. It must never reach production: allowing eval is most of the
  point of having a script-src. An unset or unexpected NODE_ENV lands on the
  safe side.
*/

/** The script-src directive, with a nonce when one is given. */
export function scriptSrcFor(nodeEnv, nonce) {
  const base = nonce
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`
    : "script-src 'self' 'unsafe-inline'";
  return nodeEnv === "development" ? `${base} 'unsafe-eval'` : base;
}

/** The whole policy. */
export function cspFor(nodeEnv, nonce) {
  return [
    "default-src 'self'",
    scriptSrcFor(nodeEnv, nonce),
    // Tailwind and next/font emit inline styles; a nonce cannot cover style
    // attributes, so styles stay 'unsafe-inline' (both reviews: acceptable).
    "style-src 'self' 'unsafe-inline'",
    // next/font self-hosts, so no external font origin is needed.
    "font-src 'self'",
    "img-src 'self' data: blob:",
    // Stripe Checkout is hosted (a full redirect), so no frame or connect
    // allowance is required for it here. Revisit only if we ever embed Elements.
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/** The paths whose pages get a per-request nonce (src/proxy.ts matches the same). */
export const NONCE_PATH_PREFIX = "/training/book/";
