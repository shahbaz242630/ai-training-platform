import { describe, it, expect, afterEach } from "vitest";
import { redact, maskEmail, REDACTED, logger, setLogSink, resetLogSink } from "./logger";

afterEach(() => resetLogSink());

describe("redaction", () => {
  it("removes secret-bearing keys regardless of casing or separators", () => {
    const input = {
      STRIPE_SECRET_KEY: "sk_test_abc123",
      clientSecret: "shhh",
      Authorization: "Bearer xyz",
      api_key: "k",
      cardNumber: "4242424242424242",
      cvv: "123",
      sessionSlug: "ai-agents",
    };
    const output = redact(input) as Record<string, unknown>;
    expect(output.STRIPE_SECRET_KEY).toBe(REDACTED);
    expect(output.clientSecret).toBe(REDACTED);
    expect(output.Authorization).toBe(REDACTED);
    expect(output.api_key).toBe(REDACTED);
    expect(output.cardNumber).toBe(REDACTED);
    expect(output.cvv).toBe(REDACTED);
    // Non-sensitive fields must survive, or the logs become useless.
    expect(output.sessionSlug).toBe("ai-agents");
  });

  it("masks emails rather than dropping them, so bookings stay traceable", () => {
    expect(maskEmail("ada@example.com")).toBe("a**@example.com");
    expect(redact("contact ada@example.com now")).toBe("contact a**@example.com now");
  });

  it("masks emails nested inside objects and arrays", () => {
    const output = redact({ customers: [{ email: "bob@test.co" }] }) as {
      customers: { email: string }[];
    };
    expect(output.customers[0]!.email).toBe("b**@test.co");
  });

  it("does not leak a stack trace through an Error", () => {
    const output = redact(new Error("boom")) as Record<string, unknown>;
    expect(output).toEqual({ name: "Error", message: "boom" });
    expect(output.stack).toBeUndefined();
  });

  it("terminates on deeply nested structures", () => {
    let nested: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 40; i++) nested = { nested };
    expect(() => redact(nested)).not.toThrow();
  });
});

describe("logger", () => {
  it("redacts context before it reaches the sink", () => {
    const seen: unknown[] = [];
    setLogSink((record) => seen.push(record));

    logger.error("checkout failed", { stripeSecretKey: "sk_live_real", email: "x@y.com" });

    const record = seen[0] as { level: string; context: Record<string, unknown> };
    expect(record.level).toBe("error");
    expect(record.context.stripeSecretKey).toBe(REDACTED);
    expect(record.context.email).toBe("x**@y.com");
  });
});
