import { timingSafeEqual } from "node:crypto";

/**
 * Who is allowed to trigger a scheduled job.
 *
 * These routes are reachable by anyone who can send an HTTP request, because
 * that is the whole point - Supabase Cron calls them over the network. So the
 * shared secret is the only thing between a stranger and our job runner.
 *
 * THE RULE THAT MATTERS: an unset secret denies everything. It does not
 * "allow while unconfigured", and it never falls back to open. A deploy that
 * forgets CRON_SECRET must break the job loudly rather than publish an
 * unauthenticated endpoint that expires bookings on request. Failing closed
 * costs a missed sweep; failing open costs anyone the ability to run it.
 */

export type CronAuthResult = "authorised" | "unauthorised" | "not_configured";

/**
 * Constant-time comparison, so the number of matching leading characters
 * cannot be read off the response time and used to guess the rest.
 *
 * Length is compared first and separately because timingSafeEqual throws on a
 * length mismatch - and lengths differing is not secret anyway.
 */
function secretsMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * `Authorization: Bearer <secret>` is the shape Supabase Cron sends through
 * pg_net, and it keeps the secret out of the URL - a query string lands in
 * access logs, proxy logs and error reports.
 */
export function authoriseCronRequest(
  authorizationHeader: string | null,
  configuredSecret: string | undefined,
): CronAuthResult {
  if (configuredSecret === undefined || configuredSecret === "") return "not_configured";
  if (authorizationHeader === null) return "unauthorised";

  const prefix = "Bearer ";
  if (!authorizationHeader.startsWith(prefix)) return "unauthorised";

  const presented = authorizationHeader.slice(prefix.length);
  return secretsMatch(presented, configuredSecret) ? "authorised" : "unauthorised";
}
