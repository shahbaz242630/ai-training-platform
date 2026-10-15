import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "@/data/db";
import { MockPaymentProvider } from "@/domain/payments/mock-provider";
import { RefundUnclearError } from "@/domain/payments/provider";
import { MockSchedulingProvider } from "@/domain/scheduling/mock-provider";
import { resetAuditSink, setAuditSink } from "@/lib/audit";
import { resetLogSink, setLogSink, type LogRecord } from "@/lib/logger";

/**
 * The sweep's refund step, from the outside: a withdrawal's refund is asked
 * for on the next run, a run with no refunds never needs payments set up,
 * and money owed that cannot go back raises the alarm on every run.
 */

const SECRET = "sweep-secret-long-enough-for-the-minimum-length";
const state = vi.hoisted(() => ({ paymentsConfigured: true }));
let payments = new MockPaymentProvider();
let db: PGlite;

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ CRON_SECRET: "sweep-secret-long-enough-for-the-minimum-length" }),
  clientEnv: { NEXT_PUBLIC_SITE_ENV: "development", NEXT_PUBLIC_SITE_URL: "http://localhost:3000" },
}));

vi.mock("@/domain/payments/factory", () => ({
  getPaymentProvider: () => {
    if (!state.paymentsConfigured) throw new Error("STRIPE_SECRET_KEY is not configured");
    return payments;
  },
  paymentsAreConfigured: () => state.paymentsConfigured,
}));

vi.mock("@/domain/scheduling/factory", () => ({
  getSchedulingProvider: () => new MockSchedulingProvider(),
  calendarIsConfigured: () => true,
  resetSchedulingProvider: () => undefined,
}));

vi.mock("@/data/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/db")>()),
  withTransaction: async <T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> =>
    db.transaction((tx) => work(tx as unknown as QueryRunner)),
}));

import { POST } from "./route";

let logs: LogRecord[];
let n = 0;

beforeAll(async () => {
  db = await PGlite.create();
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(dir, file), "utf8"));
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  state.paymentsConfigured = true;
  payments = new MockPaymentProvider();
  logs = [];
  setLogSink((r) => {
    logs.push(r);
  });
  setAuditSink(() => undefined);
  await db.query(`delete from refunds`);
});

afterEach(() => {
  resetLogSink();
  resetAuditSink();
});

async function run() {
  const response = await POST(
    new Request("https://example.test/api/cron/sweep-holds", {
      method: "POST",
      headers: new Headers({ authorization: `Bearer ${SECRET}` }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** A withdrawn, paid order with its refund owed, as the withdrawal form leaves it. */
async function refundOwed(): Promise<{ refundId: string; orderId: string }> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Europe/London') returning id`,
    [`sweeprefund${n}@example.com`],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_payment_intent_id)
     values ($1, 'single', 'ai-foundations', 129900, 'paid', $2) returning id`,
    [customer.rows[0]!.id, `pi_sweep_${n}`],
  );
  const orderId = order.rows[0]!.id;
  const refund = await db.query<{ id: string }>(
    `insert into refunds (order_id, origin, amount_fils, currency, status)
     values ($1, 'processor', 129900, 'AED', 'due') returning id`,
    [orderId],
  );
  return { refundId: refund.rows[0]!.id, orderId };
}

const errors = () => logs.filter((l) => l.level === "error").map((l) => l.message);

describe("refunds owed", () => {
  it("are asked for on the next run, and reported", async () => {
    await refundOwed();
    const result = await run();
    expect(result.status).toBe(200);
    expect(result.body.refunds).toMatchObject({ claimed: 1, issued: 1 });
    expect(payments.refundRequests).toHaveLength(1);
    expect(result.body.refundsNeedingAttention).toBe(0);
  });

  it("need nothing from payments on a run with none", async () => {
    state.paymentsConfigured = false;
    const result = await run();
    expect(result.status).toBe(200);
    expect(result.body.refunds).toEqual({ waiting: false });
    expect(errors()).not.toContain("payments are not configured, so refunds owed must wait");
  });

  it("wait, said out loud, while payments are not configured; the rest of the sweep still runs", async () => {
    state.paymentsConfigured = false;
    await refundOwed();
    const result = await run();
    expect(result.status).toBe(200);
    expect(result.body.refunds).toEqual({ error: "payments not configured" });
    expect(result.body.retention).toBeDefined();
  });

  it("raise the alarm on every run once they cannot go back", async () => {
    const { refundId } = await refundOwed();
    await db.query(`update refunds set attempts = 7 where id = $1`, [refundId]);
    payments.refundFailures.push(new RefundUnclearError("timeout"));
    const first = await run();
    expect(first.body.refundsNeedingAttention).toBe(1);
    expect(errors().some((m) => m.startsWith("REFUNDS NEED A PERSON"))).toBe(true);

    logs = [];
    const second = await run();
    expect(second.body.refundsNeedingAttention).toBe(1);
    expect(errors().some((m) => m.startsWith("REFUNDS NEED A PERSON"))).toBe(true);
  });
});
