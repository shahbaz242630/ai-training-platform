import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "@/data/db";
import { applyRefundEvent } from "@/data/refunds";
import { issueDueRefunds } from "@/data/refund-issuer";
import { recordWithdrawal } from "@/data/withdrawals";
import { MockEmailProvider } from "@/domain/messaging/mock-provider";
import type { EmailMessage, EmailProvider, SendResult } from "@/domain/messaging/provider";
import { MockPaymentProvider } from "@/domain/payments/mock-provider";
import { resetAuditSink, setAuditSink } from "@/lib/audit";
import { resetLogSink, setLogSink, type LogRecord } from "@/lib/logger";

/**
 * The emails around a withdrawal. The acknowledgement goes straight away (the
 * page promises it and the law asks for it without delay), and never twice
 * when the five-minute job reaches the same row at the same moment. Once the
 * refund has been issued, a second short email says so, exactly once, whether
 * the issuer or Stripe's webhook got there first.
 */

const state = vi.hoisted(() => ({ delayMs: 0 }));
const inner = vi.hoisted(() => ({ mail: undefined as unknown as MockEmailProvider }));
let db: PGlite;

/** The mock, optionally slow, so two senders can genuinely overlap. */
const slowMail: EmailProvider = {
  send: async (message: EmailMessage): Promise<SendResult> => {
    if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));
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
  getEmailProvider: () => slowMail,
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
import { sendQueuedMessageNow } from "./deliver";

let runner: QueryRunner;
let logs: LogRecord[];
let n = 0;
const transaction = <T>(work: (r: QueryRunner) => Promise<T>) =>
  db.transaction((tx) => work(tx as unknown as QueryRunner));

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

beforeEach(() => {
  state.delayMs = 0;
  inner.mail = new MockEmailProvider();
  logs = [];
  setLogSink((r) => {
    logs.push(r);
  });
  setAuditSink(() => undefined);
});

afterEach(() => {
  resetLogSink();
  resetAuditSink();
});

/** A paid booking withdrawn just now: the notice kept, the refund owed, the acknowledgement queued. */
async function withdrawn(): Promise<{ bookingId: string; orderId: string; email: string }> {
  n += 1;
  const email = `withdraw-mail${n}@example.com`;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Test', 'Booking', $1, 'Europe/London') returning id`,
    [email],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_payment_intent_id)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid', $2) returning id`,
    [customer.rows[0]!.id, `pi_withdraw_mail_${n}`],
  );
  const start = new Date(Date.UTC(2027, 5, 1, 14) + n * 3 * 60 * 60_000);
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end,
                           customer_timezone)
     values ($1, 'claude-claude-code', 1, 'confirmed', $2, $3, 'Europe/London') returning id`,
    [order.rows[0]!.id, start, new Date(start.getTime() + 90 * 60_000)],
  );
  const bookingId = booking.rows[0]!.id;
  await recordWithdrawal(runner, {
    bookingId,
    fullName: "Test Booking",
    email,
    statement: "I, Test Booking, withdraw from my contract.",
    refundDueFils: 149900,
    receivedAt: new Date(Date.now() - 1000),
    ipAddress: null,
    userAgent: null,
  });
  return { bookingId, orderId: order.rows[0]!.id, email };
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

const rows = async (bookingId: string, templateKey: string) =>
  (
    await db.query<{ status: string }>(
      `select status from communication_log where booking_id = $1 and template_key = $2`,
      [bookingId, templateKey],
    )
  ).rows;

const sentTo = (email: string) => inner.mail.sent.filter((m) => m.to === email);

describe("the acknowledgement, straight away", () => {
  it("is sent at once, by the same path the five-minute job uses", async () => {
    const { bookingId, email } = await withdrawn();
    const outcome = await sendQueuedMessageNow({
      bookingId,
      templateKey: "withdrawal_acknowledgement",
      provider: slowMail,
      now: new Date(),
    });
    expect(outcome).toBe("sent");
    expect(sentTo(email).map((m) => m.subject)).toEqual([
      expect.stringMatching(/^We have received your withdrawal/),
    ]);
    expect(sentTo(email)[0]?.bcc).toBe("help@example.com");
    expect(await rows(bookingId, "withdrawal_acknowledgement")).toEqual([{ status: "sent" }]);
  });

  it("is sent once when the five-minute job runs at the same moment", async () => {
    const { bookingId, email } = await withdrawn();
    state.delayMs = 30;
    await Promise.all([
      sendQueuedMessageNow({
        bookingId,
        templateKey: "withdrawal_acknowledgement",
        provider: slowMail,
        now: new Date(),
      }),
      runCron(),
    ]);
    expect(sentTo(email).filter((m) => m.subject.startsWith("We have received"))).toHaveLength(1);
  });

  it("stays queued for the five-minute job when the immediate send fails", async () => {
    const { bookingId, email } = await withdrawn();
    inner.mail.failNext({ ok: false, code: "network", message: "down", retryable: true });
    const outcome = await sendQueuedMessageNow({
      bookingId,
      templateKey: "withdrawal_acknowledgement",
      provider: slowMail,
      now: new Date(),
    });
    expect(outcome).toBe("retry");
    expect(await rows(bookingId, "withdrawal_acknowledgement")).toEqual([{ status: "queued" }]);

    // The job's next run, once the retry is due.
    await db.query(
      `update communication_log set scheduled_for = now() - interval '1 minute',
                                    last_attempt_at = now() - interval '11 minutes'
        where booking_id = $1 and template_key = 'withdrawal_acknowledgement'`,
      [bookingId],
    );
    await runCron();
    expect(sentTo(email)).toHaveLength(1);
    expect(await rows(bookingId, "withdrawal_acknowledgement")).toEqual([{ status: "sent" }]);
  });

  it("does nothing for a booking with nothing of that kind queued", async () => {
    const { bookingId } = await withdrawn();
    expect(
      await sendQueuedMessageNow({
        bookingId,
        templateKey: "reminder_24h",
        provider: slowMail,
        now: new Date(),
      }),
    ).toBe("nothing_queued");
  });
});

describe("the refund-issued email", () => {
  it("follows the whole withdrawal, and is queued once however the refund is heard of", async () => {
    const { bookingId, orderId, email } = await withdrawn();

    // 1. The acknowledgement goes straight away.
    await sendQueuedMessageNow({
      bookingId,
      templateKey: "withdrawal_acknowledgement",
      provider: slowMail,
      now: new Date(),
    });
    expect(sentTo(email)).toHaveLength(1);
    expect(sentTo(email)[0]?.text).toContain("and email you when the refund has been issued");

    // 2. The sweep issues the refund: the second email is queued.
    const payments = new MockPaymentProvider();
    await issueDueRefunds({ provider: payments, transaction, clock: () => new Date() });
    expect(await rows(bookingId, "refund_issued")).toEqual([{ status: "queued" }]);

    // 3. Stripe's webhook for the same refund queues nothing more.
    const refund = await db.query<{ id: string; provider_refund_id: string }>(
      `select id, provider_refund_id from refunds where order_id = $1`,
      [orderId],
    );
    await transaction((r) =>
      applyRefundEvent(
        r,
        {
          kind: "refund",
          eventId: "evt_flow",
          type: "refund.updated",
          occurredAt: new Date(Date.now() + 60_000),
          ignorable: false,
          orderId,
          refundRowId: refund.rows[0]!.id,
          providerRefundId: refund.rows[0]!.provider_refund_id,
          paymentIntentId: `pi_withdraw_mail_${n}`,
          amountFils: 149900,
          currency: "AED",
          status: "succeeded",
        },
        new Date(),
      ),
    );
    expect(await rows(bookingId, "refund_issued")).toHaveLength(1);

    // 4. The five-minute job sends it, though the booking is cancelled, and without a copy to the desk.
    await runCron();
    const issued = sentTo(email).find((m) => m.subject.startsWith("Your refund has been issued"));
    expect(issued?.subject).toMatch(/^Your refund has been issued \(booking [0-9A-F]{8}\)$/);
    expect(issued?.text).toContain(
      "Test, your refund of AED 1,499 has been issued to the card you paid with.",
    );
    expect(issued?.bcc).toBeUndefined();
    expect(await rows(bookingId, "refund_issued")).toEqual([{ status: "sent" }]);
  });

  it("is queued when Stripe's webhook gets there first", async () => {
    const { bookingId, orderId } = await withdrawn();
    const refund = await db.query<{ id: string }>(`select id from refunds where order_id = $1`, [
      orderId,
    ]);
    await transaction((r) =>
      applyRefundEvent(
        r,
        {
          kind: "refund",
          eventId: "evt_first",
          type: "refund.created",
          occurredAt: new Date(),
          ignorable: false,
          orderId,
          refundRowId: refund.rows[0]!.id,
          providerRefundId: `re_first_${n}`,
          paymentIntentId: `pi_withdraw_mail_${n}`,
          amountFils: 149900,
          currency: "AED",
          status: "pending",
        },
        new Date(),
      ),
    );
    expect(await rows(bookingId, "refund_issued")).toEqual([{ status: "queued" }]);
  });

  it("is never queued for a refund somebody made in the dashboard", async () => {
    const { bookingId } = await withdrawn();
    await transaction((r) =>
      applyRefundEvent(
        r,
        {
          kind: "refund",
          eventId: "evt_dash",
          type: "refund.created",
          occurredAt: new Date(),
          ignorable: false,
          orderId: null,
          refundRowId: null,
          providerRefundId: `re_dash_${n}`,
          paymentIntentId: `pi_withdraw_mail_${n}`,
          amountFils: 149900,
          currency: "AED",
          status: "succeeded",
        },
        new Date(),
      ),
    );
    expect(await rows(bookingId, "refund_issued")).toEqual([]);
  });

  it("is not queued for a refund that failed", async () => {
    const { bookingId, orderId } = await withdrawn();
    const refund = await db.query<{ id: string }>(`select id from refunds where order_id = $1`, [
      orderId,
    ]);
    await transaction((r) =>
      applyRefundEvent(
        r,
        {
          kind: "refund",
          eventId: "evt_failed",
          type: "refund.failed",
          occurredAt: new Date(),
          ignorable: false,
          orderId,
          refundRowId: refund.rows[0]!.id,
          providerRefundId: `re_failed_${n}`,
          paymentIntentId: `pi_withdraw_mail_${n}`,
          amountFils: 149900,
          currency: "AED",
          status: "failed",
        },
        new Date(),
      ),
    );
    expect(await rows(bookingId, "refund_issued")).toEqual([]);
  });
});
