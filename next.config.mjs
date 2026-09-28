/**
 * Next.js configuration.
 *
 * WHY .mjs AND NOT .ts
 *
 * Next compiles a TypeScript config to a temporary file with SWC and then
 * imports it. Under the WebAssembly compiler - which this project needs,
 * because the deployment host's glibc is too old for the native binary - that
 * temporary file is never produced, and the build dies with:
 *
 *   Failed to load next.config.ts
 *   Cannot find module '.../<hash>.next.config'  ERR_MODULE_NOT_FOUND
 *
 * Plain JavaScript needs no compilation step, so the config loads whatever
 * compiler is in use. The JSDoc annotation below keeps full type checking and
 * editor completion, so nothing is actually lost.
 *
 * This can go back to .ts if the host ever ships glibc >= 2.29 and the native
 * compiler works again.
 */

/**
 * Content Security Policy: built in src/config/content-security-policy.mjs.
 *
 * The statically prerendered pages keep `'unsafe-inline'` in script-src: the
 * App Router injects inline hydration scripts into them, and a nonce needs
 * per-request rendering. They take no input. The booking pages, which take
 * personal details and hand off to Stripe, are rendered per request anyway and
 * get a per-request nonce from src/proxy.ts instead (security audit and scans,
 * 2026-09-27/28), so this file sends them no policy of its own.
 */
import { cspFor, NONCE_PATH_PREFIX, scriptSrcFor } from "./src/config/content-security-policy.mjs";

export { scriptSrcFor };

const CSP = cspFor(process.env.NODE_ENV);

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  // Two years, subdomains included. Only sent over HTTPS by the browser.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Stops the browser guessing a content type and executing something as script.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // frame-ancestors above supersedes this, kept for older browsers.
  { key: "X-Frame-Options", value: "DENY" },
  // Do not leak our full URLs (which can carry a session slug) to other origins.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // We need none of these. Denying them shrinks the attack surface.
  {
    key: "Permissions-Policy",
    // interest-cohort (FLoC) dropped in 2026-09: browsers no longer implement it.
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  },
  // No Flash or PDF cross-domain policy may apply to this site (scan, 2026-09-28).
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  { key: "X-DNS-Prefetch-Control", value: "on" },

  /*
    Cross-origin isolation. Flagged by the ZAP baseline scan (rule 90004).

    COOP severs the window relationship with any cross-origin opener, which
    blocks cross-window attacks. CORP stops other origins embedding our
    responses as subresources.

    COEP is set to `credentialless` rather than `require-corp` deliberately:
    require-corp rejects every cross-origin subresource that does not opt in,
    which is safe today only because the site is entirely self-hosted, and
    would break the first time an external asset is added. credentialless
    gives most of the protection without that trap. Revisit if we ever embed
    Stripe Elements rather than redirecting to hosted Checkout.
  */
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
];

/*
  Which headers go where. Every path gets every security header, except that
  the booking pages get no Content-Security-Policy from here: src/proxy.ts
  sends theirs, with a fresh nonce. Two policies on one response would both be
  enforced, so the page must carry only the nonce one. Exported so a test pins
  exactly which paths get which.
*/
const nonceSegment = NONCE_PATH_PREFIX.replace(/^\//, "");
export function headerRules() {
  return [
    { source: `/:path((?!${nonceSegment}).*)`, headers: SECURITY_HEADERS },
    {
      source: `${NONCE_PATH_PREFIX}:path*`,
      headers: SECURITY_HEADERS.filter((h) => h.key !== "Content-Security-Policy"),
    },
  ];
}

/*
  The coaching policies are published once, on the company site next to the
  Knowledge Centre that sells the sessions. These old addresses may already be
  in emails, bookmarks or Stripe's settings, so each is a permanent redirect to
  its page there rather than a second copy that could drift from it.
  Exported so a test pins the exact list.
*/
export const POLICY_REDIRECTS = [
  {
    source: "/training/terms",
    destination: "https://zaaheen.com/knowledge-centre/terms/",
    permanent: true,
  },
  {
    source: "/training/refunds-cancellations",
    destination: "https://zaaheen.com/knowledge-centre/booking-and-refunds/",
    permanent: true,
  },
  {
    source: "/training/privacy",
    destination: "https://zaaheen.com/knowledge-centre/privacy/",
    permanent: true,
  },
];

/*
  The booking desk only (founder, 2026-09-27). This host is where "Book your
  session" lands; the page people find for coaching is the Knowledge Centre on
  zaaheen.com. The root was an old company placeholder ("in development"), so it
  now sends everyone there permanently. Exported so a test pins it.
*/
export const HOME_REDIRECT = {
  source: "/",
  destination: "https://zaaheen.com/knowledge-centre/",
  permanent: true,
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for the managed Node host: emits a self-contained server bundle
  // and keeps us portable rather than tied to one provider.
  output: "standalone",

  // Never ship a build that only compiles because type errors were ignored.
  // (Next 16 removed the `eslint` config key along with lint-during-build;
  // linting is a separate, required CI job instead.)
  typescript: { ignoreBuildErrors: false },

  // Hides the framework version from responses. Minor, but free.
  poweredByHeader: false,

  async headers() {
    return headerRules();
  },

  async redirects() {
    return [...POLICY_REDIRECTS, HOME_REDIRECT];
  },
};

export default nextConfig;
