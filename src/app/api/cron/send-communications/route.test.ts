import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { queueForBooking } from "@/data/communications";
import { recordWithdrawal } from "@/data/withdrawals";
import { bookingReference } from "@/domain/booking/withdrawal";
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
  emailLinkSecret: "e".repeat(40) as string | undefined,
}));

let provider = new MockEmailProvider();
let db: PGlite;

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({
    CRON_SECRET: state.cronSecret,
    MANAGE_LINK_SECRET: state.manageSecret,
    EMAIL_LINK_SECRET: state.emailLinkSecret,
  }),
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

import { calendarUid } from "./deliver";
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
  state.emailLinkSecret = "e".repeat(40);
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
  options: {
    meetingUrl?: string | null;
    times?: boolean;
    consent?: boolean;
    slug?: string;
  } = {},
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
     values ($1, 'single', $2, 149900, 'paid') returning id`,
    [customerId, options.slug ?? "claude-claude-code"],
  );
  const withTimes = options.times ?? true;
  // A distinct slot per booking: bookings that overlap are refused by the database.
  const start = new Date(Date.UTC(2027, 2, 10, 14, 0) + counter * 3 * 60 * 60_000);
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end, customer_timezone, meeting_url)
     values ($1, $6, 1, $2, $3, $4, 'Europe/London', $5) returning id`,
    [
      order.rows[0]?.id,
      withTimes ? "scheduled" : "awaiting_schedule",
      withTimes ? start : null,
      withTimes ? new Date(start.getTime() + 90 * 60_000) : null,
      options.meetingUrl ?? null,
      options.slug ?? "claude-claude-code",
    ],
  );
  return {
    bookingId: booking.rows[0]?.id ?? "",
    email: `send${counter}@example.com`,
    customerId,
    orderId: order.rows[0]?.id ?? "",
  };
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

    // Bring the retry forward rather than waiting, past the claim's ten-minute lease too.
    await db.query(
      `update communication_log
          set scheduled_for = $2, last_attempt_at = $2::timestamptz - interval '11 minutes'
        where booking_id = $1`,
      [bookingId, PAST],
    );
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

  /*
    Changed with the emails about the next session: marketing is queued for
    everybody and decided when due, so a refusal is the ordinary outcome. It
    is withdrawn (cancelled), never sent, and not left for a person.
  */
  it("refuses a marketing message for a customer with no recorded consent", async () => {
    const { bookingId } = await scheduledBooking({ consent: false });
    await queueForBooking(runner, bookingId, [{ templateKey: "newsletter", scheduledFor: PAST }]);

    await run();

    expect(provider.sent).toEqual([]);
    expect((await rowFor(bookingId, "newsletter"))?.status).toBe("cancelled");
  });

  it("leaves a message for a booking with no time to a person rather than guessing", async () => {
    const { bookingId } = await scheduledBooking({ times: false });
    await queueForBooking(runner, bookingId, [{ templateKey: "reminder_24h", scheduledFor: PAST }]);

    await run();

    expect(provider.sent).toEqual([]);
    expect((await rowFor(bookingId, "reminder_24h"))?.last_error).toBe("booking_has_no_time");
  });

  /*
    The one session email that does go without a time: the payment
    acknowledgement, for a payment that arrived after its time was gone. The
    contract is confirmed in writing whatever happens to the time.
  */
  it("acknowledges a payment for a booking with no time, saying the time is still to be chosen", async () => {
    const { bookingId, email } = await scheduledBooking({ times: false });
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);

    await run();

    const sent = provider.sent.find((m) => m.to === email);
    expect(sent?.text).toContain("to be chosen");
    expect(sent?.text).toContain("refund you in full");
    expect((await rowFor(bookingId, "payment_receipt"))?.status).toBe("sent");
  });

  it("carries on past one bad message and sends the rest", async () => {
    const bad = await scheduledBooking({ times: false });
    const good = await scheduledBooking();
    await queueForBooking(runner, bad.bookingId, [
      { templateKey: "reminder_24h", scheduledFor: PAST },
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
      route: "automatic",
      cardCountry: "GB",
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
    // Nothing sent to the processor yet: the promise, not a claim.
    expect(sent?.text).toContain("We will refund AED 1,499");
    expect((await rowFor(bookingId, "withdrawal_acknowledgement"))?.status).toBe("sent");
  });

  it("says the refund has been issued once the processor has it", async () => {
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
      route: "automatic",
      cardCountry: "GB",
    });
    await runner.query(
      `update refunds set status = 'pending', provider_refund_id = 're_send_issued'
        where withdrawal_request_id = (select id from withdrawal_requests where booking_id = $1)`,
      [bookingId],
    );

    await run();

    const sent = provider.sent.find(
      (m) => m.to === email && m.subject.startsWith("We have received your withdrawal"),
    );
    expect(sent?.text).toContain("We have issued a full refund of AED 1,499");
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
      route: "automatic",
      cardCountry: "GB",
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

    expect(provider.sent[0]?.html).not.toContain("/book/manage?t=");
    expect(provider.sent[0]?.text).toContain("hours before it starts: reply to this email.");
  });

  it("offers no move in a confirmation sent after the customer has already moved", async () => {
    const { bookingId } = await scheduledBooking({ meetingUrl: "https://teams.example/join" });
    await queueForBooking(runner, bookingId, [
      { templateKey: "booking_confirmation", scheduledFor: PAST },
    ]);
    // The move lands before the send run reaches the queued confirmation.
    await db.query("update bookings set reschedule_count = 1 where id = $1", [bookingId]);

    await run();

    const sent = provider.sent[0];
    expect(sent?.html).not.toContain("/book/manage?t=");
    expect(sent?.text).toContain("Your session has been moved once, so its time is final.");
    expect(sent?.text).not.toMatch(/move your session once|different time/i);
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
    expect(sent?.html).not.toContain("/book/manage?t=");
    const ics = (sent?.attachments?.[0]?.content ?? "").replace(/\r\n /g, "");
    expect(ics).toContain(`UID:${calendarUid(bookingId)}`);
    expect(ics).not.toContain(bookingId);
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
    expect(ics).toContain(`UID:${calendarUid(bookingId)}`);
    expect(ics).toContain("URL:https://teams.example/join");
    expect(ics).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(ics).not.toContain("ATTENDEE");
    // Calendars are shared; the reference plus the owner's email would open the withdrawal form.
    expect(ics).not.toContain("Booking reference");
    expect(ics).not.toContain(bookingReference(bookingId));
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

  it("attaches the printed terms of the version the customer agreed to", async () => {
    const { bookingId } = await scheduledBooking();
    await db.query(
      `insert into booking_consents (order_id, terms_version, key_terms, agreement_text,
         within_cancellation_period, express_request, express_request_text, text_sha256, accepted_at)
       select order_id, '2026-10-08', 'A term.', 'agree', false, false, null, $2, now()
         from bookings where id = $1`,
      [bookingId, "0".repeat(64)],
    );
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);

    await run();

    const file = provider.sent[0]?.attachments?.[0];
    expect(file?.name).toBe("Zaaheen-Knowledge-Centre-Terms-2026-10-08.pdf");
    expect(file?.contentType).toBe("application/pdf");
    expect(file?.encoding).toBe("base64");
    expect(
      Buffer.from(file?.content ?? "", "base64")
        .subarray(0, 5)
        .toString("latin1"),
    ).toBe("%PDF-");
  });

  it("still sends, without a PDF and with an alarm, for terms never printed", async () => {
    const { bookingId } = await scheduledBooking();
    await db.query(
      `insert into booking_consents (order_id, terms_version, key_terms, agreement_text,
         within_cancellation_period, express_request, express_request_text, text_sha256, accepted_at)
       select order_id, '2026-09-27', 'A term.', 'agree', false, false, null, $2, now()
         from bookings where id = $1`,
      [bookingId, "0".repeat(64)],
    );
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: PAST },
    ]);

    await run();

    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]?.attachments).toBeUndefined();
    expect(logs.some((l) => l.level === "error" && l.message.includes("no printed terms"))).toBe(
      true,
    );
  });
});

/*
  The customer's own link to choose a time for a paid booking with no time
  (founder decision, October 2026). Checked again at sending: a booking that
  has a time by now, an order no longer exactly paid, or one that was ever
  disputed is withdrawn, not sent and not counted as a failure.
*/
describe("the choose-a-time email", () => {
  it("sends the customer a working link, with a copy to the desk", async () => {
    const { bookingId, email } = await scheduledBooking({ times: false });
    await queueForBooking(runner, bookingId, [
      { templateKey: "choose_new_time", scheduledFor: PAST },
    ]);

    await run();

    const sent = provider.sent.find((m) => m.to === email);
    expect(sent?.subject).toContain("Choose a time for your session");
    expect(sent?.html).toContain("http://localhost:3000/training/book/manage?t=");
    expect(sent?.text).toContain("does not use up your one free move");
    expect(sent?.bcc).toBe("help@example.com");
    expect((await rowFor(bookingId, "choose_new_time"))?.status).toBe("sent");
  });

  it("is withdrawn when the booking has a time by the time it would go", async () => {
    const { bookingId, email } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [
      { templateKey: "choose_new_time", scheduledFor: PAST },
    ]);

    const result = await run();

    expect(provider.sent.map((m) => m.to)).not.toContain(email);
    expect((await rowFor(bookingId, "choose_new_time"))?.status).toBe("cancelled");
    expect(result.body).toMatchObject({ failed: 0 });
  });

  it("is withdrawn for an order that was ever disputed: a person decides", async () => {
    const { bookingId, email } = await scheduledBooking({ times: false });
    await db.query(
      `insert into payment_disputes (provider_dispute_id, order_id, amount_minor, currency, reason, status)
       select 'dp_send_' || b.id, b.order_id, 149900, 'AED', 'fraudulent', 'won'
         from bookings b where b.id = $1`,
      [bookingId],
    );
    await queueForBooking(runner, bookingId, [
      { templateKey: "choose_new_time", scheduledFor: PAST },
    ]);

    await run();

    expect(provider.sent.map((m) => m.to)).not.toContain(email);
    expect((await rowFor(bookingId, "choose_new_time"))?.status).toBe("cancelled");
  });
});

describe("the choose-a-time email, when it cannot honestly go", () => {
  it("is withdrawn for an order no longer exactly paid", async () => {
    const { bookingId, email } = await scheduledBooking({ times: false });
    await db.query(
      `update orders set payment_status = 'partially_refunded'
        where id = (select order_id from bookings where id = $1)`,
      [bookingId],
    );
    await queueForBooking(runner, bookingId, [
      { templateKey: "choose_new_time", scheduledFor: PAST },
    ]);

    await run();

    expect(provider.sent.map((m) => m.to)).not.toContain(email);
    expect((await rowFor(bookingId, "choose_new_time"))?.status).toBe("cancelled");
  });

  it("is left for a person, not sent without a link, when no link can be made", async () => {
    state.manageSecret = undefined;
    try {
      const { bookingId, email } = await scheduledBooking({ times: false });
      await queueForBooking(runner, bookingId, [
        { templateKey: "choose_new_time", scheduledFor: PAST },
      ]);

      await run();

      expect(provider.sent.map((m) => m.to)).not.toContain(email);
      expect((await rowFor(bookingId, "choose_new_time"))?.last_error).toBe("no_link_secret");
    } finally {
      state.manageSecret = "x".repeat(40);
    }
  });
});

/*
  Occasional emails about new sessions need the address's owner to confirm
  them. The booking confirmation carries that one link, and only while the
  customer asked for them and has neither confirmed nor withdrawn.
*/
describe("confirming emails about new sessions", () => {
  const CONFIRM = "http://localhost:3000/training/book/email/confirm?t=e1.confirm.";

  async function confirmationFor(options: { consent: boolean; set?: string }) {
    const { bookingId, email } = await scheduledBooking({
      meetingUrl: "https://teams.example/join",
      consent: options.consent,
    });
    if (options.set) {
      await db.query(`update customers set ${options.set} = now() where email = $1`, [email]);
    }
    await queueForBooking(runner, bookingId, [
      { templateKey: "booking_confirmation", scheduledFor: PAST },
    ]);
    await run();
    return provider.sent.at(-1);
  }

  it("asks the customer who ticked the box to confirm their address", async () => {
    const sent = await confirmationFor({ consent: true });
    expect(sent?.html).toContain(CONFIRM);
    expect(sent?.text).toContain("Confirm that this is your email address");
  });

  it("asks nobody who did not tick it, already confirmed, or unsubscribed", async () => {
    for (const options of [
      { consent: false },
      { consent: true, set: "marketing_consent_confirmed_at" },
      { consent: true, set: "unsubscribed_at" },
    ]) {
      const sent = await confirmationFor(options);
      expect(sent?.html).not.toContain("/book/email/confirm");
    }
  });

  it("carries no link that cannot work when no secret is configured", async () => {
    state.emailLinkSecret = undefined;
    const sent = await confirmationFor({ consent: true });
    expect(sent?.html).not.toContain("/book/email/confirm");
  });

  it("does not depend on the booking-link secret", async () => {
    state.manageSecret = undefined;
    const sent = await confirmationFor({ consent: true });
    expect(sent?.html).toContain(CONFIRM);
  });

  it("is never in a reminder", async () => {
    const { bookingId } = await scheduledBooking({
      meetingUrl: "https://teams.example/join",
      consent: true,
    });
    await queueForBooking(runner, bookingId, [{ templateKey: "reminder_24h", scheduledFor: PAST }]);
    await run();
    expect(provider.sent.at(-1)?.html).not.toContain("/book/email/confirm");
  });
});

/*
  The two emails about the next session in the series. They are marketing:
  queued for everybody, and only sent when due to somebody whose consent the
  address's owner confirmed, who has not unsubscribed, and who has not
  already booked the next session or anything further on.
*/
describe("emails about the next session", () => {
  async function nudgeFor(
    options: {
      consent?: boolean;
      set?: string;
      slug?: string;
      which?: "next_session_nudge_1" | "next_session_nudge_2";
    } = {},
  ) {
    const booked = await scheduledBooking({
      meetingUrl: "https://teams.example/join",
      consent: options.consent ?? true,
      ...(options.slug ? { slug: options.slug } : {}),
    });
    for (const column of (options.set ?? "marketing_consent_confirmed_at").split(",")) {
      if (column) {
        await db.query(`update customers set ${column} = now() where id = $1`, [booked.customerId]);
      }
    }
    const key = options.which ?? "next_session_nudge_1";
    await queueForBooking(runner, booked.bookingId, [{ templateKey: key, scheduledFor: PAST }]);
    return { ...booked, key };
  }

  it("sends the first to a confirmed customer: the next session, its link, and a way out", async () => {
    const { bookingId, key } = await nudgeFor();
    await run();

    const sent = provider.sent.at(-1);
    expect(sent?.subject).toBe(
      "Ready for the next step after Claude, Claude Code & Advanced Workflows?",
    );
    expect(sent?.text).toContain(
      "It is a month since your Claude, Claude Code & Advanced Workflows session.",
    );
    expect(sent?.html).toContain("http://localhost:3000/training/book/ai-agents");
    expect(sent?.html).toContain(
      "http://localhost:3000/training/book/email/unsubscribe?t=e1.unsubscribe.",
    );
    expect(sent?.text).toContain("you asked for occasional emails about new sessions");
    expect(sent?.text).not.toContain("about a session you booked");
    expect((await rowFor(bookingId, key))?.status).toBe("sent");
  });

  it("sends the second, which says it is the last", async () => {
    await nudgeFor({ which: "next_session_nudge_2" });
    await run();
    const sent = provider.sent.at(-1);
    expect(sent?.subject).toBe("AI Agents & Autonomous Workflows is there when you're ready");
    expect(sent?.text).toContain("We won't email you about it again.");
  });

  it("withdraws it quietly, sending nothing, without confirmed consent or after unsubscribing", async () => {
    for (const options of [
      { consent: false, set: "" },
      { consent: true, set: "" },
      { consent: true, set: "marketing_consent_confirmed_at,unsubscribed_at" },
    ]) {
      const before = provider.sent.length;
      const { bookingId, key } = await nudgeFor(options);
      await run();
      expect(provider.sent.length).toBe(before);
      expect((await rowFor(bookingId, key))?.status).toBe("cancelled");
    }
    // An ordinary outcome, so nobody is alerted about these emails.
    const aboutThese = logs.filter(
      (l) => l.level === "error" && String(l.context?.templateKey).startsWith("next_session"),
    );
    expect(aboutThese).toEqual([]);
  });

  it("withdraws it after the last session in the series", async () => {
    const { bookingId, key } = await nudgeFor({ slug: "production-ai-deployment" });
    await run();
    expect((await rowFor(bookingId, key))?.status).toBe("cancelled");
  });

  it("withdraws it when the customer already booked the next session or one further on", async () => {
    const { bookingId, key, customerId } = await nudgeFor();
    const order = await db.query<{ id: string }>(
      `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
       values ($1, 'single', 'ai-builder-tech-stack', 149900, 'paid') returning id`,
      [customerId],
    );
    const start = new Date(Date.UTC(2028, 0, 5, 14, 0) + counter * 3 * 60 * 60_000);
    await db.query(
      `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end, customer_timezone)
       values ($1, 'ai-builder-tech-stack', 1, 'scheduled', $2, $3, 'Europe/London')`,
      [order.rows[0]?.id, start, new Date(start.getTime() + 90 * 60_000)],
    );
    const before = provider.sent.length;
    await run();
    expect(provider.sent.length).toBe(before);
    expect((await rowFor(bookingId, key))?.status).toBe("cancelled");
  });

  it("is not sent about a cancelled booking", async () => {
    const { bookingId, key } = await nudgeFor();
    await db.query("update bookings set status = 'cancelled' where id = $1", [bookingId]);
    await run();
    expect((await rowFor(bookingId, key))?.status).toBe("cancelled");
  });

  it("is left for a person when no unsubscribe link can be signed", async () => {
    state.emailLinkSecret = undefined;
    const { bookingId, key } = await nudgeFor();
    const before = provider.sent.length;
    await run();
    expect(provider.sent.length).toBe(before);
    expect((await rowFor(bookingId, key))?.status).toBe("failed");
  });

  it("leaves the footer of booking emails as it was", async () => {
    const { bookingId } = await scheduledBooking({ meetingUrl: "https://teams.example/join" });
    await queueForBooking(runner, bookingId, [{ templateKey: "reminder_24h", scheduledFor: PAST }]);
    await run();
    expect(provider.sent.at(-1)?.text).toContain("about a session you booked");
    expect(provider.sent.at(-1)?.html).not.toContain("/book/email/unsubscribe");
  });
});
