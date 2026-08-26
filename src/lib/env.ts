import { z } from "zod";

/**
 * Server-side environment validation.
 *
 * Fails fast at startup rather than producing confusing runtime errors later.
 * Integration secrets are optional at this stage so the app still boots before
 * Stripe, Microsoft and Resend credentials exist - each adapter is responsible
 * for asserting its own requirements when it is actually used.
 */
const serverSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  MS_TENANT_ID: z.string().optional(),
  MS_CLIENT_ID: z.string().optional(),
  MS_CLIENT_SECRET: z.string().optional(),
  MS_CALENDAR_USER_ID: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().email().optional(),

  CRON_SECRET: z.string().optional(),
  SENTRY_DSN: z.string().optional(),
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
  NEXT_PUBLIC_SUPABASE_URL: z.string().optional(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional(),
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: z.string().optional(),
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
