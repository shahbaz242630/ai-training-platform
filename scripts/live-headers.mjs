#!/usr/bin/env node
/**
 * The security headers as the LIVE site sends them (audit s101 O-06 / #17).
 *
 * The app sets them (next.config.mjs, src/proxy.ts), but what reaches a
 * browser passes through Hostinger's CDN and Cloudflare first, and Hostinger
 * has replaced our Content-Security-Policy before (staging, September 2026).
 * The ZAP scan in CI runs against localhost, so only this sees the real path.
 *
 * Run by .github/workflows/live-headers.yml every day and after every
 * production deploy; a failure fails the workflow, and GitHub emails it.
 *
 *   node scripts/live-headers.mjs [https://coaching.zaaheen.com]
 *
 * The checks are a pure function, exported so they are tested offline.
 */
import https from "node:https";
import { fileURLToPath } from "node:url";

/** A static page (its own policy) and a booking page (a fresh nonce on every request). */
export const PAGES = [
  { path: "/training", nonce: false },
  { path: "/training/book/claude-claude-code", nonce: true },
];

const SAME_EVERYWHERE = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "cross-origin-embedder-policy": "credentialless",
  "x-permitted-cross-domain-policies": "none",
};

/** One year, at least: Cloudflare sends its own value, which wins over the app's two. */
const MIN_HSTS_SECONDS = 31_536_000;

/**
 * What is wrong with one page's headers. `get` reads a header by lower-case
 * name the way fetch does: repeated headers come back joined with ", ".
 */
export function checkHeaders(page, get) {
  const problems = [];
  for (const [name, want] of Object.entries(SAME_EVERYWHERE)) {
    if (get(name) !== want)
      problems.push(`${page.path}: ${name} is "${get(name)}", want "${want}"`);
  }

  const hsts = get("strict-transport-security") ?? "";
  const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0);
  if (maxAge < MIN_HSTS_SECONDS || !/includeSubDomains/i.test(hsts)) {
    problems.push(`${page.path}: strict-transport-security is "${hsts}"`);
  }

  const permissions = get("permissions-policy") ?? "";
  for (const feature of ["camera=()", "microphone=()", "geolocation=()", "payment=()"]) {
    if (!permissions.includes(feature)) {
      problems.push(`${page.path}: permissions-policy lacks ${feature}`);
    }
  }

  // Our policy must arrive; Hostinger appending its own "upgrade-insecure-requests" is harmless.
  const csp = get("content-security-policy") ?? "";
  for (const directive of [
    "default-src 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
  ]) {
    if (!csp.includes(directive))
      problems.push(`${page.path}: content-security-policy lacks ${directive}`);
  }
  const scriptSrc = /script-src ([^;,]*)/.exec(csp)?.[1] ?? "";
  if (page.nonce) {
    if (!/'nonce-[A-Za-z0-9+/=]+'/.test(scriptSrc) || !scriptSrc.includes("'strict-dynamic'")) {
      problems.push(`${page.path}: script-src has no nonce: "${scriptSrc}"`);
    }
    if (scriptSrc.includes("'unsafe-inline'")) {
      problems.push(`${page.path}: script-src allows 'unsafe-inline' on a booking page`);
    }
  } else if (!scriptSrc.startsWith("'self'")) {
    problems.push(`${page.path}: script-src is "${scriptSrc}"`);
  }
  return problems;
}

/** The nonce in a policy, so two requests can be shown to get different ones. */
export function nonceOf(csp) {
  return /'nonce-([A-Za-z0-9+/=]+)'/.exec(csp ?? "")?.[1] ?? null;
}

/**
 * Whether a booking page hands the browser a person-check site key. The check
 * is on from a host setting alone, so losing that setting switches it off
 * with no other sign (audit s104 COA-3); the page's own data is the proof.
 */
export function hasTurnstileKey(html) {
  return /turnstileSiteKey\\?"\s*:\s*\\?"0x[0-9A-Za-z_-]{10,}/.test(html);
}

/**
 * The status the host answers with when asked directly, skipping Cloudflare.
 * The origin gate (audit s101 #21) must answer 403. The host's certificate
 * names the site, so it is checked as for any request (verified 2026-10-20).
 */
export function probeOrigin(ip, host, path = "/training", port = 443) {
  return new Promise((resolve) => {
    const request = https.request(
      { host: ip, port, servername: host, path, headers: { Host: host } },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? null);
      },
    );
    // Why there was no answer, never the address: the run log is public (audit s104 follow-up).
    request.setTimeout(15_000, () =>
      request.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })),
    );
    request.on("error", (error) => resolve(`no answer (${error.code ?? "error"})`));
    request.end();
  });
}

/**
 * Fetch every page from the live site and report. Returns the exit code.
 * Two optional checks (audit s104 COA-3): `expectTurnstile`, that the booking
 * page carries the person check's key; `originProbe`, that a request skipping
 * Cloudflare is refused.
 */
export async function run({
  base,
  fetchImpl = fetch,
  log = console.log,
  error = console.error,
  expectTurnstile = false,
  originProbe = null,
}) {
  const root = base.replace(/\/+$/, "");
  const problems = [];
  for (const page of PAGES) {
    const response = await fetchImpl(`${root}${page.path}`, { redirect: "manual" });
    if (response.status !== 200) {
      problems.push(`${page.path}: status ${response.status}`);
      continue;
    }
    problems.push(...checkHeaders(page, (name) => response.headers.get(name)));
    if (page.nonce && expectTurnstile && !hasTurnstileKey(await response.text())) {
      problems.push(`${page.path}: no person-check key on the page; is TURNSTILE_SECRET_KEY set?`);
    }
    if (page.nonce) {
      // A nonce served from a cache is a nonce an attacker can read and reuse.
      const again = await fetchImpl(`${root}${page.path}`, { redirect: "manual" });
      if (again.status !== 200) {
        problems.push(`${page.path}: status ${again.status} on the second request`);
        continue;
      }
      const first = nonceOf(response.headers.get("content-security-policy"));
      const second = nonceOf(again.headers.get("content-security-policy"));
      if (first !== null && first === second) {
        problems.push(
          `${page.path}: the same nonce came back twice; something is caching the page`,
        );
      }
    }
  }
  if (originProbe !== null) {
    const status = await originProbe();
    if (status !== 403) {
      problems.push(
        `straight to the host (skipping Cloudflare): status ${status ?? "no answer"}, want 403; is ORIGIN_SECRET set?`,
      );
    }
  }
  if (problems.length > 0) {
    error(`Live security headers on ${root}: ${problems.length} problem(s)`);
    for (const p of problems) error(`  - ${p}`);
    return 1;
  }
  log(`Live security headers on ${root}: all present (${PAGES.length} pages).`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const base = process.argv[2] ?? "https://coaching.zaaheen.com";
  // Workflow variables, set once each protection is on (see live-headers.yml).
  const originIp = process.env.ORIGIN_IP?.trim() ?? "";
  run({
    base,
    expectTurnstile: process.env.EXPECT_TURNSTILE === "true",
    originProbe: originIp === "" ? null : () => probeOrigin(originIp, new URL(base).hostname),
  }).then((code) => {
    process.exitCode = code;
  });
}
