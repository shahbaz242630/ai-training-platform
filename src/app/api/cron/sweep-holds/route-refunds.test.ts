import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "@/data/db";
import { MockEmailProvider } from "@/domain/messaging/mock-provider";
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
const state = vi.hoisted(() => ({ paymentsConfigured: true, emailConfigured: true }));
const mail = vi.hoisted(() => ({ current: undefined as unknown as MockEmailProvider }));
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

vi.mock("@/domain/messaging/factory", () => ({
  getEmailProvider: () => {
    if (!state.emailConfigured) throw new Error("MS_CLIENT_SECRET is not configured");
    return mail.current;
  },
  emailIsConfigured: () => state.emailConfigured,
}));

vi.mock("@/config/site", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/site")>()),
  supportEmail: () => "desk@example.com",
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
  state.emailConfigured = true;
  payments = new MockPaymentProvider();
  mail.current = new MockEmailProvider();
  logs = [];
  setLogSink((r) => {
    logs.push(r);
  });
  setAuditSink(() => undefined);
  await db.query(`delete from refunds`);
  await db.query(`delete from desk_alerts`);
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

describe("the desk is told", () => {
  it("by one email the run a refund needs a person, and not again the next run", async () => {
    const { refundId } = await refundOwed();
    await db.query(
      `update refunds set status = 'failed', last_error = 'no_payment_intent' where id = $1`,
      [refundId],
    );

    const first = await run();
    expect(first.body.deskAlerts).toEqual({ raised: 1, reminded: 0, resolved: 0, failed: 0 });
    expect(mail.current.sent.map((m) => m.to)).toEqual(["desk@example.com"]);
    expect(mail.current.sent[0]?.subject).toMatch(/^Refund needs you: booking /);

    const second = await run();
    expect(second.body.deskAlerts).toEqual({ raised: 0, reminded: 0, resolved: 0, failed: 0 });
    expect(mail.current.sent).toHaveLength(1);
  });

  it("goes on with the rest of the sweep when email is not set up, and says so", async () => {
    state.emailConfigured = false;
    const { refundId } = await refundOwed();
    await db.query(`update refunds set status = 'failed' where id = $1`, [refundId]);
    const result = await run();
    expect(result.status).toBe(200);
    expect(result.body.deskAlerts).toEqual({ error: "desk alerts could not be sent" });
    expect(result.body.retention).toBeDefined();
  });
});
