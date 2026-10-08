import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { queueForBooking } from "@/data/communications";
import { recordWithdrawal } from "@/data/withdrawals";
import type { QueryRunner } from "@/data/db";
import { MockEmailProvider } from "@/domain/messaging/mock-provider";
import { resetLogSink, setLogSink, type LogRecord } from "@/lib/logger";

/**
 * The send job, driven from the outside: an authenticated request in, sent
 * mail and queue rows out. The provider is the mock, which honours
 * idempotency; the database is a real in-process Postgres with the real
 * migrations.
 */

const state = vi.hoisted(() => ({
  cronSecret: "test-cron-secret-long-enough-for-the-minimum" as string | undefined,
  emailConfigured: true,
  realIdentity: true,
  manageSecret: "x".repeat(40) as string | undefined,
}));

let provider = new MockEmailProvider();
let db: PGlite;

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ CRON_SECRET: state.cronSecret, MANAGE_LINK_SECRET: state.manageSecret }),
  clientEnv: { NEXT_PUBLIC_SITE_ENV: "development", NEXT_PUBLIC_SITE_URL: "http://localhost:3000" },
}));

vi.mock("@/domain/messaging/factory", () => ({
  getEmailProvider: () => {
    if (!state.emailConfigured) throw new Error("MS_CLIENT_SECRET is not configured");
    return provider;
  },
  emailIsConfigured: () => state.emailConfigured,
}));

vi.mock("@/config/site", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/config/site")>();
  return {
    ...original,
    // An unfilled identity is built here, not borrowed from the real config: the
    // real values are filled in now, and this refusal must stay proven after that.
    companyName: () =>
      state.realIdentity ? "Example Training" : original.placeholder(null, "COMPANY_NAME"),
    supportEmail: () =>
      state.realIdentity ? "help@example.com" : original.placeholder(null, "SUPPORT_EMAIL"),
  };
});

vi.mock("@/data/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/db")>()),
  withTransaction: async <T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> =>
    db.transaction((tx) => work(tx as unknown as QueryRunner)),
}));

import { POST } from "./route";

let runner: QueryRunner;
let logs: LogRecord[];

beforeAll(async () => {
  db = await PGlite.create();
  const applySql = db.exec.bind(db);
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    await applySql(readFileSync(join(dir, file), "utf8"));
  }
  runner = db as unknown as QueryRunner;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  state.cronSecret = "test-cron-secret-long-enough-for-the-minimum";
  state.emailConfigured = true;
  state.realIdentity = true;
  state.manageSecret = "x".repeat(40);
  provider = new MockEmailProvider();
  logs = [];
  setLogSink((record) => {
    logs.push(record);
  });
});

afterEach(() => {
  resetLogSink();
});

let counter = 0;

async function scheduledBooking(
  options: { meetingUrl?: string | null; times?: boolean; consent?: boolean } = {},
) {
  counter += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone, marketing_consent, marketing_consent_at)
     values ('Amina', 'Khan', $1, 'Europe/London', $2, $3) returning id`,
    [`send${counter}@example.com`, options.consent ?? false, options.consent ? new Date() : null],
  );
  const customerId = customer.rows[0]?.id ?? "";
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid') returning id`,
    [customerId],
  );
  const withTimes = options.times ?? true;
  // A distinct slot per booking: bookings that overlap are refused by the database.
  const start = new Date(Date.UTC(2027, 2, 10, 14, 0) + counter * 3 * 60 * 60_000);
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end, customer_timezone, meeting_url)
     values ($1, 'claude-claude-code', 1, $2, $3, $4, 'Europe/London', $5) returning id`,
    [
      order.rows[0]?.id,
      withTimes ? "scheduled" : "awaiting_schedule",
      withTimes ? start : null,
      withTimes ? new Date(start.getTime() + 90 * 60_000) : null,
      options.meetingUrl ?? null,
    ],
  );
  return { bookingId: booking.rows[0]?.id ?? "", email: `send${counter}@example.com` };
}

const PAST = new Date(Date.now() - 60_000);
const FUTURE = new Date(Date.now() + 60 * 60_000);

async function run(secret: string | null = "test-cron-secret-long-enough-for-the-minimum") {
  const headers = new Headers();
  if (secret !== null) headers.set("authorization", `Bearer ${secret}`);
  const response = await POST(
    new Request("https://example.test/api/cron/send-communications", { method: "POST", headers }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const rowFor = async (bookingId: string, templateKey: string) =>
  (
    await db.query<{
      status: string;
      attempts: number;
      provider_message_id: string | null;
      last_error: string | null;
      scheduled_for: Date;
    }>(
      `select status, attempts, provider_message_id, last_error, scheduled_for
         from communication_log where booking_id = $1 and template_key = $2`,
      [bookingId, templateKey],
    )
  ).rows[0];

const errorMessages = () => logs.filter((l) => l.level === "error").map((l) => l.message);

describe("authentication", () => {
  it("answers 500 when no cron secret is configured, and claims nothing", async () => {
    state.cronSecret = undefined;
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);

    expect(await run()).toEqual({ status: 500, body: { error: "Not configured" } });
    expect((await rowFor(bookingId, "payment_receipt"))?.attempts).toBe(0);
  });

  it("answers 401 to a wrong or missing secret, with no detail", async () => {
    expect(await run("wrong")).toEqual({ status: 401, body: { error: "Unauthorised" } });
    expect(await run(null)).toEqual({ status: 401, body: { error: "Unauthorised" } });
  });
});

describe("when email is not configured", () => {
  it("answers 500 and leaves the queue untouched, so nothing is counted as attempted", async () => {
    state.emailConfigured = false;
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);

    expect(await run()).toEqual({ status: 500, body: { error: "Email not configured" } });
    expect((await rowFor(bookingId, "payment_receipt"))?.attempts).toBe(0);
    expect(errorMessages()).toContain("email is not configured, so queued messages are waiting");
  });
});

describe("sending what is due", () => {
  it("sends a due message to the customer, with the row id as the idempotency key, and records the provider id", async () => {
    const { bookingId, email } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);

    const result = await run();

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, retry: 0, failed: 0 });
    const row = await rowFor(bookingId, "payment_receipt");
    expect(row).toMatchObject({ status: "sent", attempts: 1 });
    expect(row?.provider_message_id).toMatch(/^email_mock_[0-9]+$/);

    // Rows left due by the early-exit tests above are sent in this run too,
    // so the assertions are on this booking, not on the totals.
    const sent = provider.sent.find((m) => m.to === email);
    expect(sent?.to).toBe(email);
    expect(sent?.subject).toContain("Payment received: Claude, Claude Code & Advanced Workflows");
    expect(sent?.text).toContain("(Europe/London)");
    expect(sent?.text).toContain("GST");
    expect(sent?.text).toContain("Example Training");
    expect(sent?.idempotencyKey).toMatch(/^communication:[0-9a-f-]{36}$/);
  });

  it("leaves a message that is not yet due alone", async () => {
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [{ templateKey: "follow_up", scheduledFor: FUTURE }]);

    const result = await run();

    expect(result.body).toMatchObject({ claimed: 0 });
    expect((await rowFor(bookingId, "follow_up"))?.attempts).toBe(0);
  });

  it("does not send the same message twice across runs", async () => {
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);

    await run();
    await run();

    expect(provider.sent.filter((m) => m.to === `send${counter}@example.com`)).toHaveLength(1);
  });
});

describe("when a send fails", () => {
  it("retries a transient failure later, and succeeds on the next due run", async () => {
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);
    provider.failNext({ ok: false, code: "rate_limit_exceeded", message: "slow", retryable: true });

    const first = await run();

    expect(first.body).toMatchObject({ sent: 0, retry: 1, failed: 0 });
    const afterFirst = await rowFor(bookingId, "payment_receipt");
    expect(afterFirst).toMatchObject({
      status: "queued",
      attempts: 1,
      last_error: "rate_limit_exceeded",
    });
    expect(afterFirst?.scheduled_for.getTime()).toBeGreaterThan(Date.now());

    // Bring the retry forward rather than waiting a minute.
    await db.query("update communication_log set scheduled_for = $2 where booking_id = $1", [
      bookingId,
      PAST,
    ]);
    const second = await run();

    expect(second.body).toMatchObject({ sent: 1 });
    expect(await rowFor(bookingId, "payment_receipt")).toMatchObject({
      status: "sent",
      attempts: 2,
    });
  });

  it("gives up straight away on a failure a retry cannot fix", async () => {
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);
    provider.failNext({ ok: false, code: "invalid_from_address", message: "no", retryable: false });

    const result = await run();

    expect(result.body).toMatchObject({ failed: 1, failedInTotal: expect.any(Number) });
    expect(await rowFor(bookingId, "payment_receipt")).toMatchObject({
      status: "failed",
      last_error: "invalid_from_address",
    });
    expect(errorMessages()).toContain("message could not be sent and has been left for a person");
    expect(errorMessages()).toContain("messages have been given up on and need a person");
  });

  it("gives up after the attempt limit even on transient failures", async () => {
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);
    await db.query("update communication_log set attempts = 4 where booking_id = $1", [bookingId]);
    provider.failNext({
      ok: false,
      code: "internal_server_error",
      message: "down",
      retryable: true,
    });

    await run();

    expect(await rowFor(bookingId, "payment_receipt")).toMatchObject({
      status: "failed",
      attempts: 5,
      last_error: "internal_server_error",
    });
  });
});

describe("what is refused before a provider is involved", () => {
  it("never sends an email carrying an identity placeholder", async () => {
    state.realIdentity = false;
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);

    await run();

    expect(provider.sent).toEqual([]);
    expect(await rowFor(bookingId, "payment_receipt")).toMatchObject({
      status: "failed",
      last_error: "placeholder_in_content",
    });
  });

  it("refuses a confirmation for a booking that has no joining link", async () => {
    const { bookingId } = await scheduledBooking({ meetingUrl: null });
    await queueForBooking(runner, bookingId, [
      { templateKey: "booking_confirmation", scheduledFor: PAST },
    ]);

    await run();

    expect(provider.sent).toEqual([]);
    expect((await rowFor(bookingId, "booking_confirmation"))?.last_error).toMatch(
      /no joining link/,
    );
  });

  it("sends a confirmation once the booking has a joining link", async () => {
    const { bookingId } = await scheduledBooking({ meetingUrl: "https://teams.example/join/1" });
    await queueForBooking(runner, bookingId, [
      { templateKey: "booking_confirmation", scheduledFor: PAST },
    ]);

    await run();

    expect(provider.sent[0]?.text).toContain("https://teams.example/join/1");
    expect((await rowFor(bookingId, "booking_confirmation"))?.status).toBe("sent");
  });

  it("refuses a marketing message for a customer with no recorded consent", async () => {
    const { bookingId } = await scheduledBooking({ consent: false });
    await queueForBooking(runner, bookingId, [{ templateKey: "newsletter", scheduledFor: PAST }]);

    await run();

    expect(provider.sent).toEqual([]);
    expect((await rowFor(bookingId, "newsletter"))?.last_error).toMatch(/not_allowed: marketing/);
  });

  it("leaves a message for a booking with no time to a person rather than guessing", async () => {
    const { bookingId } = await scheduledBooking({ times: false });
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);

    await run();

    expect(provider.sent).toEqual([]);
    expect((await rowFor(bookingId, "payment_receipt"))?.last_error).toBe("booking_has_no_time");
  });

  it("carries on past one bad message and sends the rest", async () => {
    const bad = await scheduledBooking({ times: false });
    const good = await scheduledBooking();
    await queueForBooking(runner, bad.bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);
    await queueForBooking(runner, good.bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);

    const result = await run();

    expect(result.body).toMatchObject({ failed: 1 });
    expect(provider.sent.map((m) => m.to)).toContain(good.email);
    expect(provider.sent.map((m) => m.to)).not.toContain(bad.email);
  });
});

/*
  The acknowledgement of a withdrawal is about the notice, not a session: it
  goes whether or not the booking ever had a time, and the booking desk gets a
  blind copy, because a person must cancel the calendar event and refund.
*/
describe("the withdrawal acknowledgement", () => {
  it("is sent to the customer with a blind copy to the booking desk", async () => {
    const { bookingId, email } = await scheduledBooking();
    await recordWithdrawal(runner, {
      bookingId,
      fullName: "Amina Khan",
      email,
      statement: "I, Amina Khan, withdraw from my contract.",
      refundDueFils: 149900,
      receivedAt: PAST,
      ipAddress: null,
      userAgent: null,
    });

    const result = await run();

    expect(result.body).toMatchObject({ ok: true, failed: 0 });
    const sent = provider.sent.find((m) =>
      m.subject.startsWith("We have received your withdrawal"),
    );
    expect(sent?.to).toBe(email);
    expect(sent?.bcc).toBe("help@example.com");
    expect(sent?.text).toContain("I, Amina Khan, withdraw from my contract.");
    expect(sent?.text).toContain("AED 1,499");
    expect((await rowFor(bookingId, "withdrawal_acknowledgement"))?.status).toBe("sent");
  });

  it("is sent for a booking that never had a time", async () => {
    const { bookingId, email } = await scheduledBooking({ times: false });
    await recordWithdrawal(runner, {
      bookingId,
      fullName: "Amina Khan",
      email,
      statement: "I, Amina Khan, withdraw from my contract.",
      refundDueFils: 149900,
      receivedAt: PAST,
      ipAddress: null,
      userAgent: null,
    });

    await run();

    expect((await rowFor(bookingId, "withdrawal_acknowledgement"))?.status).toBe("sent");
  });

  it("is left for a person if the notice it acknowledges cannot be found", async () => {
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [
      { templateKey: "withdrawal_acknowledgement", scheduledFor: PAST },
    ]);

    await run();

    const row = await rowFor(bookingId, "withdrawal_acknowledgement");
    expect(row?.status).toBe("failed");
    expect(row?.last_error).toBe("no_withdrawal_on_record");
  });

  it("never copies anyone else into ordinary booking emails", async () => {
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);

    await run();

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.bcc).toBeUndefined();
  });
});

/*
  The booking desk keeps a copy of every confirmed booking in its own inbox, so
  a booking can be found there without opening the database. Only the
  confirmation: a copy of every reminder and follow-up would bury the inbox in
  four or five messages per booking.
*/
describe("the booking desk's copy", () => {
  it("gets a blind copy of the booking confirmation", async () => {
    const { bookingId, email } = await scheduledBooking({
      meetingUrl: "https://teams.example/join",
    });
    await queueForBooking(runner, bookingId, [
      { templateKey: "booking_confirmation", scheduledFor: PAST },
    ]);

    await run();

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.to).toBe(email);
    expect(provider.sent[0]?.bcc).toBe("help@example.com");
  });

  it("gets no copy of a reminder", async () => {
    const { bookingId } = await scheduledBooking({ meetingUrl: "https://teams.example/join" });
    await queueForBooking(runner, bookingId, [{ templateKey: "reminder_24h", scheduledFor: PAST }]);

    await run();

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.bcc).toBeUndefined();
  });
});

/*
  The customer is never invited from the coach's mailbox, so the confirmation
  is where the session reaches their calendar: an "add to calendar" file with
  the join link, one per booking id so a later version replaces it.
*/
/*
  Moving a session: the confirmation carries the customer's own link while
  their one move is unused, and the email after a move carries the new time,
  a copy for the booking desk, and a calendar file that replaces the first.
*/
describe("moving a session", () => {
  it("puts the customer's own move link in the booking confirmation", async () => {
    const { bookingId } = await scheduledBooking({ meetingUrl: "https://teams.example/join" });
    await queueForBooking(runner, bookingId, [
      { templateKey: "booking_confirmation", scheduledFor: PAST },
    ]);

    await run();

    expect(provider.sent[0]?.html).toContain("http://localhost:3000/training/book/manage?t=v1.");
    expect(provider.sent[0]?.text).toContain("Reschedule my session");
  });

  it("asks for a reply instead when no link can be signed", async () => {
    state.manageSecret = undefined;
    const { bookingId } = await scheduledBooking({ meetingUrl: "https://teams.example/join" });
    await queueForBooking(runner, bookingId, [
      { templateKey: "booking_confirmation", scheduledFor: PAST },
    ]);

    await run();

    expect(provider.sent[0]?.html).not.toContain("/book/manage");
    expect(provider.sent[0]?.text).toContain("Reply to this email");
  });

  it("sends the moved session's details, a desk copy and a calendar file that replaces the first", async () => {
    const { bookingId } = await scheduledBooking({ meetingUrl: "https://teams.example/join" });
    await runner.query("update bookings set reschedule_count = 1 where id = $1", [bookingId]);
    await queueForBooking(runner, bookingId, [
      { templateKey: "reschedule_confirmation", scheduledFor: PAST },
    ]);

    await run();

    const sent = provider.sent[0];
    expect(sent?.subject).toMatch(/^Moved: /);
    expect(sent?.bcc).toBe("help@example.com");
    expect(sent?.text).toContain("final");
    expect(sent?.html).not.toContain("/book/manage");
    const ics = (sent?.attachments?.[0]?.content ?? "").replace(/\r\n /g, "");
    expect(ics).toContain(`UID:booking-${bookingId}@zaaheen.com`);
    expect(ics).toContain("SEQUENCE:1");
  });
});

describe("the add-to-calendar file", () => {
  it("rides on the booking confirmation with the session's time and join link", async () => {
    const { bookingId } = await scheduledBooking({ meetingUrl: "https://teams.example/join" });
    await queueForBooking(runner, bookingId, [
      { templateKey: "booking_confirmation", scheduledFor: PAST },
    ]);

    await run();

    const files = provider.sent[0]?.attachments ?? [];
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toMatch(/\.ics$/);
    expect(files[0]?.contentType).toBe("text/calendar");
    const ics = (files[0]?.content ?? "").replace(/\r\n /g, "");
    expect(ics).toContain(`UID:booking-${bookingId}@zaaheen.com`);
    expect(ics).toContain("URL:https://teams.example/join");
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(ics).not.toContain("ATTENDEE");
  });

  it("is not attached to a reminder", async () => {
    const { bookingId } = await scheduledBooking({ meetingUrl: "https://teams.example/join" });
    await queueForBooking(runner, bookingId, [{ templateKey: "reminder_24h", scheduledFor: PAST }]);

    await run();

    expect(provider.sent[0]?.attachments).toBeUndefined();
  });
});

describe("a booking withdrawn after its reminder was queued", () => {
  it("withdraws the reminder instead of sending it, even if the send run already holds it", async () => {
    const { bookingId } = await scheduledBooking({ meetingUrl: "https://teams.example/join" });
    await queueForBooking(runner, bookingId, [{ templateKey: "reminder_24h", scheduledFor: PAST }]);
    // The withdrawal lands after the row is queued but the booking is what decides.
    await db.query(`update bookings set status = 'cancelled' where id = $1`, [bookingId]);

    const result = await run();

    expect(provider.sent).toHaveLength(0);
    expect(result.body).toMatchObject({ withdrawn: 1, failed: 0 });
    expect((await rowFor(bookingId, "reminder_24h"))?.status).toBe("cancelled");
  });
});

describe("the payment acknowledgement", () => {
  it("carries the amount paid and the terms as the consent record stored them", async () => {
    const { bookingId } = await scheduledBooking();
    await db.query(
      `insert into booking_consents (order_id, terms_version, key_terms, agreement_text,
         within_cancellation_period, express_request, express_request_text, text_sha256, accepted_at)
       select order_id, '2026-09-27', E'First stored term.\nSecond stored term.', 'agree',
              true, true, 'Stored express request.', $2, now()
         from bookings where id = $1`,
      [bookingId, "0".repeat(64)],
    );
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);

    await run();

    const sent = provider.sent[0];
    expect(sent?.text).toContain("Paid: AED 1,499");
    expect(sent?.text).toContain("First stored term.");
    expect(sent?.text).toContain("Second stored term.");
    expect(sent?.text).toContain("Stored express request.");
  });
});
