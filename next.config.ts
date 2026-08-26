import type { NextConfig } from "next";

/**
 * Content Security Policy.
 *
 * KNOWN GAP - `'unsafe-inline'` in script-src. The App Router injects inline
 * hydration scripts into statically prerendered pages, so a strict policy
 * without it breaks every page. Removing it requires nonce-based CSP, which
 * forces dynamic rendering and would cost the static delivery this landing page
 * depends on for speed on UAE mobile networks.
 *
 * Everything else is locked down, and this is revisited in Phase 3 when
 * checkout introduces dynamic routes anyway. Documented in SECURITY.md rather
 * than left as a silent weakness.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  // Tailwind and next/font emit inline styles.
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
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
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

const nextConfig: NextConfig = {
  // Required for the managed Node host: emits a self-contained server bundle
  // and keeps us portable rather than tied to one provider (decision D14).
  output: "standalone",

  // Never ship a build that only compiles because type errors were ignored.
  // (Next 16 removed the `eslint` config key along with lint-during-build;
  // linting is a separate, required CI job instead.)
  typescript: { ignoreBuildErrors: false },

  // Hides the framework version from responses. Minor, but free.
  poweredByHeader: false,

  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
