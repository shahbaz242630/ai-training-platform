import { randomUUID } from "node:crypto";
import { logger } from "./logger";

/**
 * The person check in front of checkout start (audit s101 #3 part 2).
 *
 * Starting a checkout holds a slot for 35 minutes without any payment, so one
 * caller starting checkouts in a loop could hold every slot on sale. The
 * per-network limits (#124) narrow that; this makes each attempt cost a
 * challenge solved in a real browser. The browser runs Cloudflare Turnstile
 * and sends its token; nothing is held until Cloudflare's siteverify says the
 * token was solved, for this site, for the checkout.
 *
 * Everything that is not a clear yes is a no. A token that cannot be checked
 * (Cloudflare unreachable, an answer we cannot read) is refused, never let
 * through: "could not check" must never look like "checked". The customer is
 * told which of the two happened, and the second is logged as an error.
 *
 * The caller's address is deliberately not sent. Behind Cloudflare and the
 * host, our idea of it may be a proxy's, and a wrong address only weakens
 * Cloudflare's own judgement.
 *
 * Never logs the token or the secret.
 */

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The action the widget is rendered with, and the only one accepted here. */
export const TURNSTILE_ACTION = "checkout";

/** Cloudflare's tokens are at most this long. */
const MAX_TOKEN_LENGTH = 2048;

/** Per attempt; two attempts at most, so a customer waits no more than ~8 s. */
const ATTEMPT_TIMEOUT_MS = 4_000;

export type ChallengeOutcome =
  { readonly ok: true } | { readonly ok: false; readonly kind: "refused" | "unreachable" };

interface SiteverifyAnswer {
  readonly success?: unknown;
  readonly action?: unknown;
  readonly hostname?: unknown;
  readonly "error-codes"?: unknown;
}

/** siteverify's codes that mean our setup is wrong, not the customer's check. */
const OUR_FAULT = new Set(["missing-input-secret", "invalid-input-secret", "bad-request"]);

const REFUSED = { ok: false, kind: "refused" } as const;
const UNREACHABLE = { ok: false, kind: "unreachable" } as const;

/** Ask Cloudflare whether this token was solved here, for the checkout. */
export async function verifyTurnstile({
  token,
  secret,
  expectedHostname,
  fetchImpl = fetch,
}: {
  token: unknown;
  secret: string;
  expectedHostname: string;
  fetchImpl?: typeof fetch;
}): Promise<ChallengeOutcome> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    logger.warn("checkout refused: no usable person-check token");
    return REFUSED;
  }

  // The same key on the retry, so Cloudflare treats both as one check.
  const idempotencyKey = randomUUID();
  const body = new URLSearchParams({ secret, response: token, idempotency_key: idempotencyKey });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let answer: SiteverifyAnswer;
    try {
      const response = await fetchImpl(SITEVERIFY, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      if (!response.ok) {
        logger.warn("the person check could not be read", { attempt, status: response.status });
        continue;
      }
      answer = (await response.json()) as SiteverifyAnswer;
    } catch (error) {
      logger.warn("the person check could not be reached", {
        attempt,
        error: (error as Error).message,
      });
      continue;
    }

    const codes = Array.isArray(answer["error-codes"]) ? answer["error-codes"] : [];
    if (answer.success === true) {
      const hostname = typeof answer.hostname === "string" ? answer.hostname.toLowerCase() : "";
      if (answer.action === TURNSTILE_ACTION && hostname === expectedHostname.toLowerCase()) {
        return { ok: true };
      }
      logger.warn("checkout refused: the person check was solved for something else", {
        action: typeof answer.action === "string" ? answer.action : null,
        hostname,
      });
      return REFUSED;
    }
    // Cloudflare's own fault: worth one more try with the same key.
    if (codes.includes("internal-error")) continue;
    // A wrong secret or a malformed request is our fault and refuses every
    // customer: an error, so it is noticed. A failed check is the customer's.
    if (codes.some((code) => OUR_FAULT.has(String(code)))) {
      logger.error("checkout refused: the person check is misconfigured", { codes });
    } else {
      logger.warn("checkout refused: the person check did not pass", { codes });
    }
    return REFUSED;
  }

  logger.error("the person check could not be made; checkout refused");
  return UNREACHABLE;
}

export interface TurnstileSettings {
  readonly secret: string;
  readonly siteKey: string | null;
}

export interface ChallengeRefusal {
  readonly reason: "challenge_failed";
  readonly message: string;
}

/**
 * The checkout's question: may this request take a hold? `null` means yes
 * (or the check is switched off); otherwise what to tell the customer.
 */
export async function checkoutChallenge({
  settings,
  token,
  siteUrl,
  contact,
  fetchImpl = fetch,
}: {
  settings: TurnstileSettings | null;
  token: unknown;
  /** The site's own address; its host is the only one a token may be solved on. */
  siteUrl: string;
  /** How to reach a person, for when the check cannot be made at all. */
  contact: string;
  fetchImpl?: typeof fetch;
}): Promise<ChallengeRefusal | null> {
  if (settings === null) return null;
  const outcome = await verifyTurnstile({
    token,
    secret: settings.secret,
    expectedHostname: new URL(siteUrl).hostname,
    fetchImpl,
  });
  if (outcome.ok) return null;
  return {
    reason: "challenge_failed",
    message:
      outcome.kind === "unreachable"
        ? `We couldn't check that you're a person just now. Please try again in a minute, or ${contact} and we will book you in.`
        : "We couldn't check that you're a person. Please try again.",
  };
}
