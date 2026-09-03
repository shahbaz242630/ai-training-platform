import type { EmailProvider } from "./provider";
import { EmailNotConfiguredError } from "./provider";
import { ResendEmailProvider } from "./resend-provider";
import { serverEnv } from "@/lib/env";

/**
 * The email provider the application actually uses.
 *
 * There is NO fallback to the mock when the real provider is unconfigured,
 * for the same reason the payment factory has none: a sweep that "sends"
 * every queued message into memory would mark them sent, and a customer who
 * paid would be recorded as told when they were told nothing. Missing
 * configuration throws, the sweep reports that email is unavailable, and
 * the queue keeps waiting - which is recoverable, where a false "sent" is
 * not.
 *
 * The mock is imported by tests only. Nothing here can reach it.
 */
export function getEmailProvider(): EmailProvider {
  const env = serverEnv();
  if (!env.RESEND_API_KEY) throw new EmailNotConfiguredError("RESEND_API_KEY");
  if (!env.EMAIL_FROM) throw new EmailNotConfiguredError("EMAIL_FROM");
  return new ResendEmailProvider();
}

/** Whether sending is possible at all, without constructing anything. */
export function emailIsConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}
