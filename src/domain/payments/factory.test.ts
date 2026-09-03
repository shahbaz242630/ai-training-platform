import { afterEach, describe, it, expect, vi } from "vitest";

/**
 * Which provider the application gets when Stripe is not configured.
 *
 * The answer must be NONE. A fallback to the mock would produce a checkout
 * that appears to work, issues no charge and confirms nothing - worse than an
 * outage, because an outage is visible and this would not be.
 *
 * The module graph is reset per test because environment parsing is cached
 * after its first read, so a shared module would answer with whatever the
 * first test happened to set.
 */

/*
  Every test here cold-imports the Stripe SDK after a module reset. Alone that
  takes well under a second; under the full gate, alongside several in-process
  Postgres suites, it has overrun the five-second default. The budget matches
  what the test actually does rather than the default.
*/
vi.setConfig({ testTimeout: 30_000 });

const ORIGINAL = { ...process.env };

async function loadFactory(env: Record<string, string | undefined>) {
  vi.resetModules();
  process.env = { ...ORIGINAL, ...env };
  return import("./factory");
}

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("paymentsAreConfigured", () => {
  it("is true only when both the key and the signing secret are present", async () => {
    const { paymentsAreConfigured } = await loadFactory({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
    });
    expect(paymentsAreConfigured()).toBe(true);
  });

  /*
    A key without a signing secret is the dangerous half-configuration: money
    could be taken and no delivery could ever be verified, so nothing would
    confirm. It counts as unconfigured.
  */
  it("is false when the signing secret is missing", async () => {
    const { paymentsAreConfigured } = await loadFactory({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "",
    });
    expect(paymentsAreConfigured()).toBe(false);
  });

  it("is false when the key is missing", async () => {
    const { paymentsAreConfigured } = await loadFactory({
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
    });
    expect(paymentsAreConfigured()).toBe(false);
  });

  it("is false when neither is set at all", async () => {
    const { paymentsAreConfigured } = await loadFactory({
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
    });
    expect(paymentsAreConfigured()).toBe(false);
  });
});

describe("getPaymentProvider", () => {
  it("returns a provider when Stripe is fully configured", async () => {
    const { getPaymentProvider } = await loadFactory({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
    });
    expect(getPaymentProvider()).toBeDefined();
  });

  /*
    THE test this file exists for. It must throw, and it must never quietly
    hand back something that pretends to take payments.
  */
  it("throws rather than falling back to a mock when the key is missing", async () => {
    const { getPaymentProvider } = await loadFactory({
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: "whsec_x",
    });
    expect(() => getPaymentProvider()).toThrow(/STRIPE_SECRET_KEY/);
  });

  it("throws when the signing secret is missing", async () => {
    const { getPaymentProvider } = await loadFactory({
      STRIPE_SECRET_KEY: "sk_test_x",
      STRIPE_WEBHOOK_SECRET: "",
    });
    expect(() => getPaymentProvider()).toThrow(/STRIPE_WEBHOOK_SECRET/);
  });
});
