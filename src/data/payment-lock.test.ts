import { describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import { lockPayment } from "./payment-lock";

/** The payment's own lock (review s104): taken for a payment, skipped without one. */
describe("lockPayment", () => {
  const recorder = () => {
    const calls: { sql: string; params: unknown }[] = [];
    const runner = {
      query: (sql: string, params?: unknown) => {
        calls.push({ sql, params });
        return Promise.resolve({ rows: [] });
      },
    } as unknown as QueryRunner;
    return { calls, runner };
  };

  it("takes a transaction lock keyed on the payment", async () => {
    const { calls, runner } = recorder();
    await lockPayment(runner, "pi_123");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toMatch(
      /pg_advisory_xact_lock\(hashtextextended\('payment:' \|\| \$1, 0\)\)/,
    );
    expect(calls[0]?.params).toEqual(["pi_123"]);
  });

  it("does nothing without a payment", async () => {
    const { calls, runner } = recorder();
    await lockPayment(runner, null);
    expect(calls).toHaveLength(0);
  });
});
