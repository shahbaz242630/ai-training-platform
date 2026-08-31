import { z } from "zod";

/**
 * Server-side environment validation.
 *
 * Fails fast at startup rather than producing confusing runtime errors later.
 * Integration secrets are optional at this stage so the app still boots before
 * Stripe, Microsoft and Resend credentials exist - each adapter is responsible
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
  MS_CALENDAR_USER_ID: optional(z.string()),

  RESEND_API_KEY: optional(z.string()),
  EMAIL_FROM: optional(z.string().email()),

  CRON_SECRET: optional(z.string()),
  SENTRY_DSN: optional(z.string()),
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
