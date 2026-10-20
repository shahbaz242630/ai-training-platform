import { z } from "zod";
import { logger } from "./logger";

/**
 * Server-side environment validation.
 *
 * Fails fast at startup rather than producing confusing runtime errors later.
 * Integration secrets are optional at this stage so the app still boots before
 * Stripe and Microsoft credentials exist - each adapter is responsible
 * for asserting its own requirements when it is actually used.
 */
/**
 * A variable that may be absent - and treats BLANK as absent.
 *
 * `.env` files are full of `KEY=` lines waiting to be filled in. Those arrive
 * as an empty string, which Zod reads as "present" - so `.optional()` never
 * applies and any format check fails. That failure then surfaces wherever
 * serverEnv() is first called, which is nowhere near the blank line that
 * caused it: a blank EMAIL_FROM broke the booking form and reported itself as
 * "lead capture failed".
 *
 * Anything genuinely required must NOT use this - it would let a blank value
 * pass as "not configured" rather than failing loudly.
 */
function optional<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), schema.optional());
}

const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /*
    Optional at this stage so the app still boots before the database exists.
    Whatever reads it is responsible for asserting it is present when actually
    used - a missing connection string must fail loudly at that point rather
    than become `undefined` inside a query.
  */
  DATABASE_URL: optional(z.string()),
  /*
    The PEM the database certificate chain is verified against. Without it the
    connection is encrypted but UNAUTHENTICATED - anything in the network path
    can present its own certificate and read or rewrite customer records and
    payment status. Supabase publishes a per-project certificate under Project
    Settings -> Database -> SSL Configuration.
  */
  DATABASE_CA_CERT: optional(z.string()),
  SUPABASE_SERVICE_ROLE_KEY: optional(z.string()),

  STRIPE_SECRET_KEY: optional(z.string()),
  STRIPE_WEBHOOK_SECRET: optional(z.string()),

  MS_TENANT_ID: optional(z.string()),
  MS_CLIENT_ID: optional(z.string()),
  MS_CLIENT_SECRET: optional(z.string()),
  /** The mailbox that owns the diary. */
  MS_CALENDAR_USER_ID: optional(z.string()),
  /** The mailbox every customer email is sent from: the booking desk's, not the diary's. */
  MS_MAIL_SENDER_ID: optional(z.string()),

  CRON_SECRET: optional(z.string()),
  /*
    Signs the links that let a customer manage their own booking (reschedule)
    from their email. At least 32 characters. Changing it makes every link
    already sent stop working, so set it once per environment.
  */
  MANAGE_LINK_SECRET: optional(z.string().min(32)),
  SENTRY_DSN: optional(z.string()),
  /*
    The outside monitor the five-minute sweep checks in with (audit s101 #7):
    if the check-ins stop, or say "fail", the founder is told by a service
    that does not depend on this app, its database or its email. HTTPS only.
    Unset, nothing is sent.
  */
  HEARTBEAT_URL: optional(z.string().url().startsWith("https://")),
});

/** Values safe to expose to the browser. Never add a secret here. */
const clientSchema = z.object({
  NEXT_PUBLIC_SITE_URL: z.string().url().default("http://localhost:3000"),

  /*
    Which deployment this build is. Defaults to "development" so the SAFE state
    is the default: a build that forgets to declare itself is treated as
    non-production and is never indexed. Opting IN to being indexable must be
    deliberate.
  */
  NEXT_PUBLIC_SITE_ENV: z.enum(["development", "staging", "production"]).default("development"),
  NEXT_PUBLIC_SUPABASE_URL: optional(z.string()),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: optional(z.string()),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: optional(z.string()),
});

function parse<T extends z.ZodTypeAny>(schema: T, source: unknown, label: string): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid ${label} environment variables:\n${issues}`);
  }
  return result.data;
}

export const clientEnv = parse(clientSchema, process.env, "client");

/**
 * Server env is intentionally lazy: importing this module in a client bundle
 * must not throw, and server secrets must not be evaluated at module scope.
 */
let cachedServerEnv: z.infer<typeof serverSchema> | null = null;

export function serverEnv(): z.infer<typeof serverSchema> {
  if (typeof window !== "undefined") {
    throw new Error("serverEnv() must never be called from client code.");
  }
  cachedServerEnv ??= parse(serverSchema, process.env, "server");
  return cachedServerEnv;
}

/**
 * The two values the request gate (src/proxy.ts) needs, read on their own and
 * never throwing. The gate runs on every request, so it must not depend on
 * every other setting being valid: one mistyped value elsewhere would turn
 * every page, and the payment webhook, into an error.
 *
 * ORIGIN_SECRET is the secret Cloudflare adds to every request it passes on
 * (header x-zaaheen-origin, a Cloudflare request header rule); set, a request
 * without it was sent straight to the host and is refused (audit s101 #21).
 * Set it only after the Cloudflare rule is live: unset is the way back. It is
 * read only here, not in the server schema, so a bad value cannot fail the
 * rest of the settings. A malformed secret (shorter than 32 characters) is
 * reported and treated as unset: the site stays open rather than refusing
 * everyone.
 */
export function gateSettings(): {
  readonly nodeEnv: string | undefined;
  readonly originSecret: string | null;
} {
  const secret = process.env.ORIGIN_SECRET?.trim() ?? "";
  if (secret !== "" && secret.length < 32) {
    logger.error("ORIGIN_SECRET is set but shorter than 32 characters; the gate is off");
  }
  return {
    nodeEnv: process.env.NODE_ENV,
    originSecret: secret.length >= 32 ? secret : null,
  };
}

/**
 * The person check at checkout start (audit s101 #3 part 2, src/lib/turnstile.ts),
 * read on its own like gateSettings() so a bad value elsewhere cannot fail it.
 *
 * On from the SECRET alone. A missing or mistyped site key therefore cannot
 * switch the protection off while the secret is set: the page shows no widget
 * and every checkout is refused, which is loud, rather than quietly letting
 * every caller through. Both keys are read here at request time, on the
 * server, and the page hands the site key to the browser, so the two can never
 * disagree about whether the check is on (a NEXT_PUBLIC_ value is fixed into
 * the bundle at build time and could). Unset TURNSTILE_SECRET_KEY is the way
 * back.
 */
export function turnstileSettings(): {
  readonly secret: string;
  readonly siteKey: string | null;
} | null {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim() ?? "";
  if (secret === "") return null;
  const siteKey = process.env.TURNSTILE_SITE_KEY?.trim() ?? "";
  if (siteKey === "") {
    logger.error(
      "TURNSTILE_SECRET_KEY is set without TURNSTILE_SITE_KEY; every checkout is refused",
    );
  }
  return { secret, siteKey: siteKey === "" ? null : siteKey };
}
