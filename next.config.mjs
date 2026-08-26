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
 * Content Security Policy.
 *
 * KNOWN GAP - `'unsafe-inline'` in script-src. The App Router injects inline
 * hydration scripts into statically prerendered pages, so a strict policy
 * without it breaks every page. Removing it requires nonce-based CSP, which
 * forces dynamic rendering and would cost the static delivery this landing page
 * depends on for speed on UAE mobile networks.
 *
 * Everything else is locked down, and this is revisited when checkout
 * introduces dynamic routes anyway. Documented in SECURITY.md rather than left
 * as a silent weakness.
 */
/*
  React's DEVELOPMENT build uses eval() for debugging features - reconstructing
  call stacks across environments, mainly. Our policy refuses it, which is the
  policy working, but it fills the console with an error and costs the dev
  tooling it powers.

  So 'unsafe-eval' is added in development ONLY. React never uses eval in a
  production build, so production loses nothing - and this must never leak
  there, because allowing eval is most of the point of having a script-src at
  all. scriptSrcFor is exported so a test can assert exactly that, rather
  than the rule living only in this comment.
*/
export function scriptSrcFor(nodeEnv) {
  const base = "script-src 'self' 'unsafe-inline'";
  return nodeEnv === "development" ? `${base} 'unsafe-eval'` : base;
}

const CSP = [
  "default-src 'self'",
  scriptSrcFor(process.env.NODE_ENV),
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
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
