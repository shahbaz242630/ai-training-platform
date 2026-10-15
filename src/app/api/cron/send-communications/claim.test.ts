import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { queueForBooking } from "@/data/communications";
import type { QueryRunner } from "@/data/db";
import { MockEmailProvider } from "@/domain/messaging/mock-provider";
import type { EmailMessage, EmailProvider, SendResult } from "@/domain/messaging/provider";

/**
 * The claim that keeps one email from going twice. A row stays queued while
 * it is sent, so the claim's lease must outlast the slowest send, and the job
 * must not hold rows it has not reached yet: a claim taken for a batch would
 * run down while the sends before it were still going.
 */

const hooks = vi.hoisted(() => ({
  duringSend: null as null | (() => Promise<void>),
}));
const inner = vi.hoisted(() => ({ mail: undefined as unknown as MockEmailProvider }));
let db: PGlite;

/** The mock, with a hook that runs while a send is in progress. */
const hookedMail: EmailProvider = {
  send: async (message: EmailMessage): Promise<SendResult> => {
    const hook = hooks.duringSend;
    hooks.duringSend = null;
    if (hook) await hook();
    // A fresh key per call: the real email service does not dedupe, so neither does this.
    return inner.mail.send({
      ...message,
      idempotencyKey: `${message.idempotencyKey}:${Math.random()}`,
    });
  },
};

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ CRON_SECRET: "test-cron-secret-long-enough-for-the-minimum" }),
  clientEnv: { NEXT_PUBLIC_SITE_ENV: "development", NEXT_PUBLIC_SITE_URL: "http://localhost:3000" },
}));

vi.mock("@/domain/messaging/factory", () => ({
  getEmailProvider: () => hookedMail,
  emailIsConfigured: () => true,
}));

vi.mock("@/config/site", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/site")>()),
  companyName: () => "Example Training",
  supportEmail: () => "help@example.com",
}));

vi.mock("@/data/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/db")>()),
  withTransaction: async <T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> =>
    db.transaction((tx) => work(tx as unknown as QueryRunner)),
}));

import { POST } from "./route";

let runner: QueryRunner;
let n = 0;

beforeAll(async () => {
  db = await PGlite.create();
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(dir, file), "utf8"));
  }
  runner = db as unknown as QueryRunner;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  hooks.duringSend = null;
  inner.mail = new MockEmailProvider();
  await db.query(`update communication_log set status = 'cancelled' where status = 'queued'`);
});

/** A scheduled booking with a payment receipt due. */
async function receiptDue(): Promise<{ bookingId: string; email: string }> {
  n += 1;
  const email = `claim${n}@example.com`;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Europe/London') returning id`,
    [email],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid') returning id`,
    [customer.rows[0]!.id],
  );
  const start = new Date(Date.UTC(2027, 8, 1, 14) + n * 3 * 60 * 60_000);
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end,
                           customer_timezone)
     values ($1, 'claude-claude-code', 1, 'scheduled', $2, $3, 'Europe/London') returning id`,
    [order.rows[0]!.id, start, new Date(start.getTime() + 90 * 60_000)],
  );
  const bookingId = booking.rows[0]!.id;
  await queueForBooking(runner, bookingId, [
    { templateKey: "payment_receipt", scheduledFor: new Date(Date.now() - 60_000) },
  ]);
  return { bookingId, email };
}

async function runCron() {
  const response = await POST(
    new Request("https://example.test/api/cron/send-communications", {
      method: "POST",
      headers: new Headers({
        authorization: "Bearer test-cron-secret-long-enough-for-the-minimum",
      }),
    }),
  );
  return (await response.json()) as Record<string, unknown>;
}

describe("the job's claim", () => {
  it("takes one row at a time, leaving the rest for when it gets to them", async () => {
    const a = await receiptDue();
    const b = await receiptDue();
    const c = await receiptDue();
    let untouchedDuringFirstSend = -1;
    hooks.duringSend = async () => {
      const rows = await db.query<{ n: number }>(
        `select count(*)::int as n from communication_log
          where booking_id in ($1, $2, $3) and last_attempt_at is null`,
        [a.bookingId, b.bookingId, c.bookingId],
      );
      untouchedDuringFirstSend = rows.rows[0]!.n;
    };
    const result = await runCron();
    expect(result).toMatchObject({ claimed: 3, sent: 3 });
    // While the first was being sent, the other two were not yet claimed.
    expect(untouchedDuringFirstSend).toBe(2);
  });

  it("is not taken again by another run, however long the send takes", async () => {
    const { bookingId, email } = await receiptDue();
    // While the first run is still sending, three minutes pass and the next run starts.
    hooks.duringSend = async () => {
      await db.query(
        `update communication_log set last_attempt_at = last_attempt_at - interval '3 minutes'
          where booking_id = $1`,
        [bookingId],
      );
      await runCron();
    };
    await runCron();
    expect(inner.mail.sent.filter((m) => m.to === email)).toHaveLength(1);
  });
});
