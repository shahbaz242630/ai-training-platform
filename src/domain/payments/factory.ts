import type { PaymentProvider } from "./provider";
import { PaymentNotConfiguredError } from "./provider";
import { StripePaymentProvider } from "./stripe-provider";
import { serverEnv } from "@/lib/env";

/**
 * The payment provider the application actually uses.
 *
 * There is NO fallback to the mock when Stripe is unconfigured, and that is
 * the whole point of this file existing. A silent fallback would produce a
 * checkout that appears to work, issues no charge, and confirms nothing -
 * which is worse than an outage, because an outage is visible. Missing
 * configuration throws, the route reports that payment is unavailable, and
 * nobody is told a booking exists.
 *
 * The mock is imported by tests only. Nothing here can reach it.
 */
export function getPaymentProvider(): PaymentProvider {
  const env = serverEnv();
  if (!env.STRIPE_SECRET_KEY) throw new PaymentNotConfiguredError("STRIPE_SECRET_KEY");
  if (!env.STRIPE_WEBHOOK_SECRET) throw new PaymentNotConfiguredError("STRIPE_WEBHOOK_SECRET");
  return new StripePaymentProvider();
}

/** Whether checkout can be offered at all, without constructing anything. */
export function paymentsAreConfigured(): boolean {
  const env = serverEnv();
  return Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
}
