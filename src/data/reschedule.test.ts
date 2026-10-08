import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QueryRunner } from "./db";
import { isMoveCollision, listCalendarMovesDue, moveBooking, syncCalendarMove } from "./reschedule";
import { EventNotFoundError, type TimeSlot } from "@/domain/scheduling/provider";
import { addDays, addMinutes } from "@/lib/time";

/**
 * Moving a session against the real migrations: the booking's times, the slot
 * holds behind them, the calendar flag, the messages that follow the session,
 * and the audit record - and that a lost race changes nothing.
 */

let db: PGlite;
let runner: QueryRunner;
let n = 0;

beforeAll(async () => {
  db = await PGlite.create();
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  runner = db as unknown as QueryRunner;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

interface Seeded {
  readonly bookingId: string;
  readonly orderId: string;
  readonly start: Date;
}

/** A confirmed, paid booking with its converted hold and calendar event, on a day of its own. */
async function seed(over: { calendarEventId?: string | null } = {}): Promise<Seeded> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`move${n}@example.com`],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid') returning id`,
    [customer.rows[0]!.id],
  );
  const orderId = order.rows[0]!.id;
  const start = new Date(Date.UTC(2027, 0, n * 3, 15));
  const end = addMinutes(start, 90);
  const event = over.calendarEventId === undefined ? `evt_${n}` : over.calendarEventId;
  await db.query(
    `insert into slot_holds (slot_start, slot_end, order_id, calendar_event_id, expires_at, status)
     values ($1, $2, $3, $4, $1, 'converted')`,
    [start, end, orderId, event],
  );
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start,
                           scheduled_end, customer_timezone, calendar_event_id)
     values ($1, 'claude-claude-code', 1, 'confirmed', $2, $3, 'Asia/Dubai', $4)
     returning id`,
    [orderId, start, end, event],
  );
  return { bookingId: booking.rows[0]!.id, orderId, start };
}

async function queue(bookingId: string, templateKey: string, when: Date, status = "queued") {
  await db.query(
    `insert into communication_log (booking_id, channel, template_key, status, scheduled_for)
     values ($1, 'email', $2, $3, $4)`,
    [bookingId, templateKey, status, when],
  );
}

async function message(bookingId: string, templateKey: string) {
  const r = await db.query<{ status: string; scheduled_for: Date }>(
    `select status, scheduled_for from communication_log where booking_id = $1 and template_key = $2`,
    [bookingId, templateKey],
  );
  return r.rows[0] ?? null;
}

async function bookingRow(bookingId: string) {
  const r = await db.query<{
    scheduled_start: Date;
    reschedule_count: number;
    calendar_move_due: boolean;
  }>(`select scheduled_start, reschedule_count, calendar_move_due from bookings where id = $1`, [
    bookingId,
  ]);
  return r.rows[0]!;
}

/** The single-connection test database already serialises work, so a transaction is just a call. */
const transaction = <T>(work: (r: QueryRunner) => Promise<T>): Promise<T> => work(runner);

/** Only the one method a move needs; the rest of the calendar is never touched here. */
class RecordingCalendar {
  readonly moves: { id: string; start: Date; end: Date }[] = [];
  constructor(private readonly failure: unknown = null) {}
  moveEvent(id: string, slot: TimeSlot): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure);
    this.moves.push({ id, start: slot.start, end: slot.end });
    return Promise.resolve();
  }
}

/** Run a move the way production does: inside one transaction that a throw rolls back. */
async function move(bookingId: string, newStart: Date, now: Date) {
  await db.query("begin");
  try {
    const outcome = await moveBooking(runner, {
      bookingId,
      newSlot: { start: newStart, end: addMinutes(newStart, 90) },
      now,
    });
    await db.query("commit");
    return outcome;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

describe("moveBooking", () => {
  it("moves the session, hands its event to the new time, and flags the calendar", async () => {
    const s = await seed();
    const now = addDays(s.start, -5);
    const newStart = addDays(s.start, 2);

    expect(await move(s.bookingId, newStart, now)).toEqual({
      kind: "moved",
      start: newStart,
      end: addMinutes(newStart, 90),
    });

    const row = await bookingRow(s.bookingId);
    expect(row.scheduled_start).toEqual(newStart);
    expect(row.reschedule_count).toBe(1);
    expect(row.calendar_move_due).toBe(true);

    const holds = await db.query<{
      status: string;
      calendar_event_id: string | null;
      slot_start: Date;
    }>(
      `select status, calendar_event_id, slot_start from slot_holds where order_id = $1 order by slot_start`,
      [s.orderId],
    );
    expect(holds.rows).toEqual([
      { status: "released", calendar_event_id: null, slot_start: s.start },
      { status: "converted", calendar_event_id: `evt_${n}`, slot_start: newStart },
    ]);
  });

  it("leaves the release sweep nothing to delete: the moved session's event is not released", async () => {
    const s = await seed();
    await move(s.bookingId, addDays(s.start, 2), addDays(s.start, -5));

    // The predicate the release sweep uses to find events to delete.
    const toDelete = await db.query(
      `select id from slot_holds
        where order_id = $1 and calendar_event_id is not null
          and calendar_released_at is null and status in ('expired', 'released')`,
      [s.orderId],
    );
    expect(toDelete.rows).toEqual([]);
  });

  it("refuses a second move, and the database refuses one even if the code did not", async () => {
    const s = await seed();
    const now = addDays(s.start, -5);
    await move(s.bookingId, addDays(s.start, 2), now);

    expect(await move(s.bookingId, addDays(s.start, 4), now)).toEqual({
      kind: "refused",
      reason: "already_moved",
    });
    await expect(
      db.query(`update bookings set reschedule_count = 2 where id = $1`, [s.bookingId]),
    ).rejects.toThrow(/bookings_reschedule_count_range/);
  });

  it("changes nothing when refused for lateness", async () => {
    const s = await seed();
    const outcome = await move(s.bookingId, addDays(s.start, 2), addMinutes(s.start, -60));
    expect(outcome).toEqual({ kind: "refused", reason: "too_late" });
    expect((await bookingRow(s.bookingId)).reschedule_count).toBe(0);
  });

  it("loses cleanly to a session already on the new time, and changes nothing", async () => {
    const taken = await seed();
    const mover = await seed();

    let caught: unknown;
    try {
      await move(mover.bookingId, taken.start, addDays(mover.start, -30));
    } catch (error) {
      caught = error;
    }
    expect(isMoveCollision(caught)).toBe(true);

    const row = await bookingRow(mover.bookingId);
    expect(row.scheduled_start).toEqual(mover.start);
    expect(row.reschedule_count).toBe(0);
  });

  it("moves the reminders and follow-up with the session, keeps a sent one, and queues the move email", async () => {
    const s = await seed();
    const now = addDays(s.start, -5);
    const newStart = addDays(s.start, 2);
    await queue(s.bookingId, "booking_confirmation", addDays(now, -1), "sent");
    await queue(s.bookingId, "reminder_24h", addMinutes(s.start, -24 * 60));
    await queue(s.bookingId, "reminder_3h", addMinutes(s.start, -3 * 60));
    await queue(s.bookingId, "follow_up", addMinutes(s.start, 150));

    await move(s.bookingId, newStart, now);

    expect(await message(s.bookingId, "reminder_24h")).toEqual({
      status: "queued",
      scheduled_for: addMinutes(newStart, -24 * 60),
    });
    expect(await message(s.bookingId, "reminder_3h")).toEqual({
      status: "queued",
      scheduled_for: addMinutes(newStart, -3 * 60),
    });
    expect(await message(s.bookingId, "follow_up")).toEqual({
      status: "queued",
      scheduled_for: addMinutes(newStart, 150),
    });
    expect((await message(s.bookingId, "booking_confirmation"))?.status).toBe("sent");
    expect(await message(s.bookingId, "reschedule_confirmation")).toEqual({
      status: "queued",
      scheduled_for: now,
    });
  });

  it("cancels a reminder whose new moment has already passed rather than sending it late", async () => {
    const s = await seed();
    const now = addDays(s.start, -5);
    // Moved to a time that starts in two hours: the 24h and 3h reminders are both past.
    const soon = addMinutes(now, 120);
    await queue(s.bookingId, "reminder_24h", addMinutes(s.start, -24 * 60));
    await queue(s.bookingId, "reminder_3h", addMinutes(s.start, -3 * 60));

    await move(s.bookingId, soon, now);

    expect((await message(s.bookingId, "reminder_24h"))?.status).toBe("cancelled");
    expect((await message(s.bookingId, "reminder_3h"))?.status).toBe("cancelled");
  });

  it("records who moved it, from when and to when", async () => {
    const s = await seed();
    const newStart = addDays(s.start, 2);
    await move(s.bookingId, newStart, addDays(s.start, -5));

    const audit = await db.query<{ action: string; actor_kind: string; metadata: unknown }>(
      `select action, actor_kind, metadata from audit_events where subject = $1`,
      [`booking:${s.bookingId}`],
    );
    expect(audit.rows).toEqual([
      {
        action: "booking.rescheduled",
        actor_kind: "customer",
        metadata: { from: s.start.toISOString(), to: newStart.toISOString() },
      },
    ]);
  });

  it("does not flag a calendar move for a booking that never had an event", async () => {
    const s = await seed({ calendarEventId: null });
    await move(s.bookingId, addDays(s.start, 2), addDays(s.start, -5));
    expect((await bookingRow(s.bookingId)).calendar_move_due).toBe(false);
  });

  it("hands a due calendar move to the calendar, then clears the flag", async () => {
    const s = await seed();
    const newStart = addDays(s.start, 2);
    await move(s.bookingId, newStart, addDays(s.start, -5));
    const calendar = new RecordingCalendar();

    const result = await syncCalendarMove({
      bookingId: s.bookingId,
      provider: calendar,
      transaction,
    });

    expect(result).toBe("moved");
    expect(calendar.moves).toEqual([
      { id: `evt_${n}`, start: newStart, end: addMinutes(newStart, 90) },
    ]);
    expect((await bookingRow(s.bookingId)).calendar_move_due).toBe(false);
    expect(await listCalendarMovesDue(runner, 50)).not.toContainEqual(
      expect.objectContaining({ bookingId: s.bookingId }),
    );
  });

  it("keeps the flag when the calendar fails, so the next run tries again", async () => {
    const s = await seed();
    await move(s.bookingId, addDays(s.start, 2), addDays(s.start, -5));
    const calendar = new RecordingCalendar(new Error("ECONNRESET"));

    await expect(
      syncCalendarMove({ bookingId: s.bookingId, provider: calendar, transaction }),
    ).rejects.toThrow("ECONNRESET");
    expect((await bookingRow(s.bookingId)).calendar_move_due).toBe(true);
    expect(await listCalendarMovesDue(runner, 50)).toContainEqual(
      expect.objectContaining({ bookingId: s.bookingId }),
    );
  });

  it("stops retrying an event that no longer exists, and says so", async () => {
    const s = await seed();
    await move(s.bookingId, addDays(s.start, 2), addDays(s.start, -5));
    const calendar = new RecordingCalendar(new EventNotFoundError(`evt_${n}`));

    expect(
      await syncCalendarMove({ bookingId: s.bookingId, provider: calendar, transaction }),
    ).toBe("event_missing");
    expect((await bookingRow(s.bookingId)).calendar_move_due).toBe(false);
  });

  it("leaves the calendar alone for a booking cancelled after its move", async () => {
    const s = await seed();
    await move(s.bookingId, addDays(s.start, 2), addDays(s.start, -5));
    await db.query("update bookings set status = 'cancelled' where id = $1", [s.bookingId]);
    const calendar = new RecordingCalendar();

    expect(
      await syncCalendarMove({ bookingId: s.bookingId, provider: calendar, transaction }),
    ).toBe("nothing_due");
    expect(calendar.moves).toEqual([]);
    expect(await listCalendarMovesDue(runner, 50)).not.toContainEqual(
      expect.objectContaining({ bookingId: s.bookingId }),
    );
  });

  it("has nothing to do for a booking with no move due", async () => {
    const s = await seed();
    const calendar = new RecordingCalendar();
    expect(
      await syncCalendarMove({ bookingId: s.bookingId, provider: calendar, transaction }),
    ).toBe("nothing_due");
    expect(calendar.moves).toEqual([]);
  });

  it("reports an unknown booking as not found", async () => {
    expect(await move("00000000-0000-4000-8000-000000000000", new Date(), new Date())).toEqual({
      kind: "refused",
      reason: "not_found",
    });
  });
});
