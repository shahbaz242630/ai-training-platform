import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueryRunner } from "@/data/db";
import { attachCalendarEvent, holdSlot, releaseHoldById } from "@/data/slot-holds";
import { MockSchedulingProvider } from "@/domain/scheduling/mock-provider";
import { resetAuditSink, setAuditSink } from "@/lib/audit";
import { resetLogSink, setLogSink, type LogRecord } from "@/lib/logger";
import { at } from "@/lib/time";

/**
 * The five-minute sweep, driven from the outside. Three jobs now: expire the
 * holds nobody paid for, delete the tentative calendar events those holds
 * left behind, and finish confirming paid bookings the calendar step did not
 * manage the first time.
 */

const state = vi.hoisted(() => ({
  cronSecret: "sweep-secret" as string | undefined,
  calendarDown: false,
}));

const EVERY_DAY = {
  windows: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday: weekday as 0 | 1 | 2 | 3 | 4 | 5 | 6,
    startMinutes: at(0),
    endMinutes: at(24),
  })),
  slotIntervalMinutes: 30,
  bufferMinutes: 0,
  minimumNoticeHours: 0,
  bookingHorizonDays: 3650,
};

let provider = new MockSchedulingProvider({ rules: EVERY_DAY });
let db: PGlite;

vi.mock("@/lib/env", () => ({
  serverEnv: () => ({ CRON_SECRET: state.cronSecret }),
  clientEnv: { NEXT_PUBLIC_SITE_ENV: "development", NEXT_PUBLIC_SITE_URL: "http://localhost:3000" },
}));

vi.mock("@/domain/scheduling/factory", () => ({
  getSchedulingProvider: () => {
    if (state.calendarDown) throw new Error("MS_CLIENT_SECRET is not configured");
    return provider;
  },
  calendarIsConfigured: () => !state.calendarDown,
  resetSchedulingProvider: () => undefined,
}));

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
  state.cronSecret = "sweep-secret";
  state.calendarDown = false;
  provider = new MockSchedulingProvider({ rules: EVERY_DAY });
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

async function run(secret: string | null = "sweep-secret") {
  const headers = new Headers();
  if (secret !== null) headers.set("authorization", `Bearer ${secret}`);
  const response = await POST(
    new Request("https://example.test/api/cron/sweep-holds", { method: "POST", headers }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

let counter = 0;
function nextSlot() {
  counter += 1;
  // One slot per day at 14:00 Dubai time: hours apart would eventually cross midnight, which the rules refuse.
  const start = new Date(Date.UTC(2027, 7, 1 + counter, 10, 0));
  return { start, end: new Date(start.getTime() + 90 * 60_000) };
}

/** A hold in the database with a real tentative event in the calendar behind it. */
async function holdWithEvent(expiresAt: Date) {
  const slot = nextSlot();
  const outcome = await holdSlot({ slotStart: slot.start, slotEnd: slot.end, expiresAt }, (work) =>
    work(runner),
  );
  if (!outcome.ok) throw new Error("setup could not hold");
  const event = await provider.holdSlot({
    slot,
    subject: "x",
    attendeeName: "A",
    attendeeEmail: "a@example.com",
    holdReference: outcome.hold.id,
  });
  await attachCalendarEvent(runner, outcome.hold.id, event.externalId);
  return { holdId: outcome.hold.id, eventId: event.externalId };
}

const holdRow = async (id: string) =>
  (
    await db.query<{ status: string; calendar_released_at: Date | null }>(
      "select status, calendar_released_at from slot_holds where id = $1",
      [id],
    )
  ).rows[0];

async function paidScheduledBooking() {
  counter += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`sweep${counter}@example.com`],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid') returning id`,
    [customer.rows[0]?.id],
  );
  const slot = nextSlot();
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end, customer_timezone)
     values ($1, 'claude-claude-code', 1, 'scheduled', $2, $3, 'Asia/Dubai') returning id`,
    [order.rows[0]?.id, slot.start, slot.end],
  );
  return booking.rows[0]?.id ?? "";
}

const PAST = new Date(Date.now() - 60_000);
const FUTURE = new Date(Date.now() + 30 * 60_000);

describe("authentication", () => {
  it("answers 500 without a configured secret and 401 to a wrong one", async () => {
    state.cronSecret = undefined;
    expect((await run()).status).toBe(500);
    state.cronSecret = "sweep-secret";
    expect((await run("wrong")).status).toBe(401);
    expect((await run(null)).status).toBe(401);
  });
});

describe("expired holds and their calendar events", () => {
  it("expires a due hold and deletes the tentative event it left on the calendar", async () => {
    const { holdId, eventId } = await holdWithEvent(PAST);

    const result = await run();

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, calendarEventsStillBlocking: 0 });
    expect(await holdRow(holdId)).toMatchObject({ status: "expired" });
    expect((await holdRow(holdId))?.calendar_released_at).not.toBeNull();
    expect(await provider.getEvent(eventId)).toBeNull();
  });

  it("deletes the event behind a hold that was released, not only an expired one", async () => {
    const { holdId, eventId } = await holdWithEvent(FUTURE);
    await releaseHoldById(runner, holdId);

    await run();

    expect(await provider.getEvent(eventId)).toBeNull();
    expect((await holdRow(holdId))?.calendar_released_at).not.toBeNull();
  });

  it("leaves a live hold and its event alone", async () => {
    const { holdId, eventId } = await holdWithEvent(FUTURE);

    await run();

    expect(await holdRow(holdId)).toMatchObject({ status: "held", calendar_released_at: null });
    expect(await provider.getEvent(eventId)).not.toBeNull();
  });

  it("keeps trying next run when the calendar is unreachable, and says so", async () => {
    const { holdId, eventId } = await holdWithEvent(PAST);
    state.calendarDown = true;

    const result = await run();

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ calendarEventsStillBlocking: 1 });
    expect((await holdRow(holdId))?.calendar_released_at).toBeNull();
    expect(logs.some((l) => l.level === "error" && l.message.includes("not configured"))).toBe(
      true,
    );

    state.calendarDown = false;
    await run();
    expect(await provider.getEvent(eventId)).toBeNull();
  });
});

describe("paid bookings the calendar step did not finish", () => {
  it("confirms them, with a join link and the messages queued", async () => {
    const bookingId = await paidScheduledBooking();

    const result = await run();

    expect(result.body).toMatchObject({ confirmations: { confirmed: 1, slotLost: 0, failed: 0 } });
    const row = await db.query<{ status: string; meeting_url: string | null }>(
      "select status, meeting_url from bookings where id = $1",
      [bookingId],
    );
    expect(row.rows[0]).toMatchObject({ status: "confirmed" });
    expect(row.rows[0]?.meeting_url).toMatch(/^https:\/\/teams\.mock\.invalid\//);
    const queued = await db.query<{ n: string }>(
      "select count(*)::text as n from communication_log where booking_id = $1",
      [bookingId],
    );
    expect(Number(queued.rows[0]?.n)).toBe(4);
  });

  it("counts a failure and moves on when the calendar is unreachable", async () => {
    await paidScheduledBooking();
    state.calendarDown = true;

    const result = await run();

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ confirmations: expect.objectContaining({ confirmed: 0 }) });
    expect((result.body.confirmations as { failed: number }).failed).toBeGreaterThan(0);
  });
});
