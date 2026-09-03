import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AvailabilityRules } from "@/config/availability";
import {
  MockSchedulingProvider,
  type MockSchedulingProviderOptions,
} from "@/domain/scheduling/mock-provider";
import type {
  ConfirmSlotInput,
  HoldSlotInput,
  SchedulingProvider,
} from "@/domain/scheduling/provider";
import { resetAuditSink, setAuditSink, type AuditEvent } from "@/lib/audit";
import { resetLogSink, setLogSink, type LogRecord } from "@/lib/logger";
import { at, type Weekday } from "@/lib/time";
import {
  bookingIdsForOrder,
  confirmBookingOnCalendar,
  listBookingsAwaitingConfirmation,
  loadBookingForConfirmation,
} from "./confirmation";
import type { QueryRunner } from "./db";

/**
 * The step from paid-and-scheduled to confirmed-with-a-link, against a real
 * Postgres and the in-memory calendar. What matters most here is that every
 * path is safe to repeat, and that the one path a retry cannot fix - the
 * calendar losing the slot - leaves the order paid and a person alerted.
 */

const EVERY_DAY: AvailabilityRules = {
  windows: ([0, 1, 2, 3, 4, 5, 6] as Weekday[]).map((weekday) => ({
    weekday,
    startMinutes: at(0),
    endMinutes: at(24),
  })),
  slotIntervalMinutes: 30,
  bufferMinutes: 0,
  minimumNoticeHours: 0,
  bookingHorizonDays: 3650,
};

const NOW = new Date("2026-10-01T09:00:00Z");
let db: PGlite;
let runner: QueryRunner;
const transaction = <T>(work: (r: QueryRunner) => Promise<T>) =>
  db.transaction((tx) => work(tx as unknown as QueryRunner));

let audits: AuditEvent[];
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
  audits = [];
  logs = [];
  setAuditSink((e) => {
    audits.push(e);
  });
  setLogSink((r) => {
    logs.push(r);
  });
});

afterEach(() => {
  resetAuditSink();
  resetLogSink();
});

let counter = 0;

async function scheduledBooking(options: { paid?: boolean; calendarEventId?: string | null } = {}) {
  counter += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`confirm${counter}@example.com`],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'claude-claude-code', 149900, $2) returning id`,
    [customer.rows[0]?.id, options.paid === false ? "pending" : "paid"],
  );
  const start = new Date(Date.UTC(2027, 3, 10, 14, 0) + counter * 3 * 60 * 60_000);
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end, customer_timezone, calendar_event_id)
     values ($1, 'claude-claude-code', 1, 'scheduled', $2, $3, 'Asia/Dubai', $4) returning id`,
    [
      order.rows[0]?.id,
      start,
      new Date(start.getTime() + 90 * 60_000),
      options.calendarEventId ?? null,
    ],
  );
  return { orderId: order.rows[0]?.id ?? "", bookingId: booking.rows[0]?.id ?? "", start };
}

const calendar = (seed: MockSchedulingProviderOptions = {}) =>
  new MockSchedulingProvider({ now: () => NOW, rules: EVERY_DAY, ...seed });

const bookingRow = async (id: string) =>
  (
    await db.query<{
      status: string;
      meeting_url: string | null;
      calendar_event_id: string | null;
    }>("select status, meeting_url, calendar_event_id from bookings where id = $1", [id])
  ).rows[0];

const queuedFor = async (bookingId: string) =>
  (
    await db.query<{ template_key: string }>(
      "select template_key from communication_log where booking_id = $1 order by scheduled_for, template_key",
      [bookingId],
    )
  ).rows.map((r) => r.template_key);

describe("confirmBookingOnCalendar", () => {
  it("promotes the held event, records the link, confirms the booking, and queues every message", async () => {
    const provider = calendar();
    const { bookingId, start } = await scheduledBooking();
    const held = await provider.holdSlot({
      slot: { start, end: new Date(start.getTime() + 90 * 60_000) },
      subject: "x",
      attendeeName: "Amina Khan",
      attendeeEmail: "a@example.com",
    });
    await db.query("update bookings set calendar_event_id = $2 where id = $1", [
      bookingId,
      held.externalId,
    ]);

    const outcome = await confirmBookingOnCalendar({ bookingId, provider, now: NOW, transaction });

    expect(outcome).toBe("confirmed");
    expect(await bookingRow(bookingId)).toEqual({
      status: "confirmed",
      meeting_url: `https://teams.mock.invalid/meet/${held.externalId}`,
      calendar_event_id: held.externalId,
    });
    expect(provider.invitations.get(held.externalId)).toEqual({
      attendeeName: "Amina Khan",
      attendeeEmail: `confirm${counter}@example.com`,
    });
    expect(await queuedFor(bookingId)).toEqual([
      "booking_confirmation",
      "reminder_24h",
      "reminder_3h",
      "follow_up",
    ]);
    expect(audits).toContainEqual(
      expect.objectContaining({ action: "booking.confirmed", subject: `booking:${bookingId}` }),
    );
  });

  it("blocks the calendar first when checkout could not, then confirms", async () => {
    const provider = calendar();
    const { bookingId } = await scheduledBooking({ calendarEventId: null });

    const outcome = await confirmBookingOnCalendar({ bookingId, provider, now: NOW, transaction });

    expect(outcome).toBe("confirmed");
    expect(provider.listEvents()).toHaveLength(1);
    expect((await bookingRow(bookingId))?.calendar_event_id).toBe("mock_evt_1");
  });

  it("is a no-op the second time, and queues nothing twice", async () => {
    const provider = calendar();
    const { bookingId } = await scheduledBooking();
    await confirmBookingOnCalendar({ bookingId, provider, now: NOW, transaction });
    audits = [];

    const again = await confirmBookingOnCalendar({ bookingId, provider, now: NOW, transaction });

    expect(again).toBe("already_confirmed");
    expect(await queuedFor(bookingId)).toHaveLength(4);
    expect(audits).toEqual([]);
  });

  it("returns the booking to waiting when the calendar has lost the slot, and alerts", async () => {
    const provider = calendar();
    const { bookingId, start } = await scheduledBooking();
    const held = await provider.holdSlot({
      slot: { start, end: new Date(start.getTime() + 90 * 60_000) },
      subject: "x",
      attendeeName: "A",
      attendeeEmail: "a@example.com",
    });
    await provider.cancelEvent(held.externalId);
    await db.query("update bookings set calendar_event_id = $2 where id = $1", [
      bookingId,
      held.externalId,
    ]);

    const outcome = await confirmBookingOnCalendar({ bookingId, provider, now: NOW, transaction });

    expect(outcome).toBe("slot_lost");
    expect(await bookingRow(bookingId)).toEqual({
      status: "awaiting_schedule",
      meeting_url: null,
      calendar_event_id: null,
    });
    expect(await queuedFor(bookingId)).toEqual([]);
    expect(
      logs.some((l) => l.level === "error" && l.message.includes("NO LONGER HAS THE SLOT")),
    ).toBe(true);
  });

  it("refuses an order that is not paid, whatever the booking says", async () => {
    const { bookingId } = await scheduledBooking({ paid: false });
    expect(
      await confirmBookingOnCalendar({ bookingId, provider: calendar(), now: NOW, transaction }),
    ).toBe("order_not_paid");
  });

  it("does nothing for a booking that does not exist or is not scheduled", async () => {
    expect(
      await confirmBookingOnCalendar({
        bookingId: "00000000-0000-4000-8000-000000000000",
        provider: calendar(),
        now: NOW,
        transaction,
      }),
    ).toBe("not_scheduled");
  });

  it("lets a calendar outage propagate, so the caller retries rather than records a confirmation", async () => {
    const { bookingId } = await scheduledBooking();
    const down: SchedulingProvider = {
      ...calendar(),
      holdSlot: () => Promise.reject(new Error("ECONNRESET")),
      confirmSlot: () => Promise.reject(new Error("ECONNRESET")),
    } as unknown as SchedulingProvider;

    await expect(
      confirmBookingOnCalendar({ bookingId, provider: down, now: NOW, transaction }),
    ).rejects.toThrow("ECONNRESET");
    expect((await bookingRow(bookingId))?.status).toBe("scheduled");
  });
});

describe("lookups", () => {
  it("lists paid, scheduled bookings awaiting confirmation and leaves the rest alone", async () => {
    const provider = calendar();
    const waiting = await scheduledBooking();
    const done = await scheduledBooking();
    await confirmBookingOnCalendar({ bookingId: done.bookingId, provider, now: NOW, transaction });
    const unpaid = await scheduledBooking({ paid: false });

    const ids = await listBookingsAwaitingConfirmation(runner, 100);

    expect(ids).toContain(waiting.bookingId);
    expect(ids).not.toContain(done.bookingId);
    expect(ids).not.toContain(unpaid.bookingId);
  });

  it("finds the bookings on an order and the full context of one", async () => {
    const { orderId, bookingId } = await scheduledBooking();
    expect(await bookingIdsForOrder(runner, orderId)).toEqual([bookingId]);
    expect(await loadBookingForConfirmation(runner, bookingId)).toMatchObject({
      id: bookingId,
      orderId,
      status: "scheduled",
      orderPaymentStatus: "paid",
      customerFirstName: "Amina",
      customerEmail: `confirm${counter}@example.com`,
    });
  });
});

describe("edges", () => {
  it("still confirms a booking whose session is no longer in the catalogue, with a plain subject", async () => {
    const provider = calendar();
    const { bookingId } = await scheduledBooking();
    await db.query("update bookings set session_slug = 'retired-session' where id = $1", [
      bookingId,
    ]);

    expect(await confirmBookingOnCalendar({ bookingId, provider, now: NOW, transaction })).toBe(
      "confirmed",
    );
  });

  it("refuses to record a confirmation the calendar issued without a link", async () => {
    const { bookingId } = await scheduledBooking();
    const base = calendar();
    const linkless: SchedulingProvider = {
      ...base,
      holdSlot: (input: HoldSlotInput) => base.holdSlot(input),
      confirmSlot: async (id: string, attendee: ConfirmSlotInput) => ({
        ...(await base.confirmSlot(id, attendee)),
        meetingUrl: null,
      }),
    } as unknown as SchedulingProvider;

    await expect(
      confirmBookingOnCalendar({ bookingId, provider: linkless, now: NOW, transaction }),
    ).rejects.toThrow(/without a meeting link/);
    expect((await bookingRow(bookingId))?.status).toBe("scheduled");
  });
});
