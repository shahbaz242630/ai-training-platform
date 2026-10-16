import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import {
  adoptRestoredEvents,
  anyBookingChanged,
  listWatchedBookings,
  type WatchedBooking,
} from "./calendar-watch";

/**
 * The Outlook watch, the part that reads the database: which bookings are
 * watched, and whether one changed while the calendar was being read.
 *
 * The selection has no limit on purpose. The desk alerts close every open
 * alert missing from what they are given, so a capped list would close and
 * reopen alerts run after run.
 */

let db: PGlite;
let runner: QueryRunner;
const NOW = new Date("2026-10-16T12:00:00Z");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
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

beforeEach(async () => {
  await db.query(`delete from bookings`);
});

interface BookingInput {
  readonly status?: string;
  readonly startOffsetMs?: number;
  readonly eventId?: string | null;
  readonly meetingUrl?: string | null;
  readonly moveDue?: boolean;
  readonly updatedAt?: Date;
}

/** A paid booking, one day apart from every other so they never overlap. */
async function insertBooking(input: BookingInput = {}): Promise<string> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Europe/London') returning id`,
    [`watch${n}@example.com`],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'ai-foundations', 129900, 'paid') returning id`,
    [customer.rows[0]!.id],
  );
  const start = new Date(NOW.getTime() + (input.startOffsetMs ?? n * DAY));
  const end = new Date(start.getTime() + 90 * 60_000);
  const status = input.status ?? "confirmed";
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end,
                           customer_timezone, calendar_event_id, meeting_url, calendar_move_due,
                           updated_at)
     values ($1, 'ai-foundations', 1, $2, $3, $4, 'Europe/London', $5, $6, $7, $8)
     returning id`,
    [
      order.rows[0]!.id,
      status,
      status === "awaiting_schedule" ? null : start,
      status === "awaiting_schedule" ? null : end,
      input.eventId === undefined ? `evt-${n}` : input.eventId,
      input.meetingUrl === undefined ? `https://teams.example/meet/${n}` : input.meetingUrl,
      input.moveDue ?? false,
      input.updatedAt ?? NOW,
    ],
  );
  return booking.rows[0]!.id;
}

const ids = (list: readonly WatchedBooking[]) => list.map((b) => b.bookingId).toSorted();

describe("which bookings are watched", () => {
  it("every confirmed booking that has not finished, with its event and Teams link", async () => {
    const id = await insertBooking({ eventId: "evt-x", meetingUrl: "https://teams.example/x" });
    const watched = await listWatchedBookings(runner, NOW);
    expect(watched).toHaveLength(1);
    expect(watched[0]).toMatchObject({
      bookingId: id,
      calendarEventId: "evt-x",
      meetingUrl: "https://teams.example/x",
    });
    expect(watched[0]!.end.getTime() - watched[0]!.start.getTime()).toBe(90 * 60_000);
  });

  it("includes a session in progress and leaves out one that has ended", async () => {
    const inProgress = await insertBooking({ startOffsetMs: -30 * 60_000 });
    await insertBooking({ startOffsetMs: -3 * HOUR });
    expect(ids(await listWatchedBookings(runner, NOW))).toEqual([inProgress]);
  });

  it("leaves out bookings that are not confirmed or have no event", async () => {
    await insertBooking({ status: "cancelled" });
    await insertBooking({ status: "scheduled" });
    await insertBooking({ status: "awaiting_schedule", eventId: null });
    await insertBooking({ eventId: null });
    expect(await listWatchedBookings(runner, NOW)).toEqual([]);
  });

  it("leaves out a fresh move (its event shows the old time on purpose) but not a stuck one", async () => {
    await insertBooking({ moveDue: true, updatedAt: new Date(NOW.getTime() - 10 * 60_000) });
    const stuck = await insertBooking({
      moveDue: true,
      updatedAt: new Date(NOW.getTime() - 2 * HOUR),
    });
    expect(ids(await listWatchedBookings(runner, NOW))).toEqual([stuck]);
  });

  it("has no limit", async () => {
    for (let i = 0; i < 30; i += 1) await insertBooking();
    expect(await listWatchedBookings(runner, NOW)).toHaveLength(30);
  });
});

describe("a booking that changed during the check", () => {
  it("is noticed when it was cancelled, moved, given another event, or flagged for a move", async () => {
    const changes = [
      `update bookings set status = 'cancelled' where id = $1`,
      `update bookings set scheduled_start = scheduled_start + interval '1 day',
                           scheduled_end = scheduled_end + interval '1 day' where id = $1`,
      `update bookings set calendar_event_id = 'evt-other' where id = $1`,
      `update bookings set calendar_move_due = true where id = $1`,
    ];
    for (const change of changes) {
      await db.query(`delete from bookings`);
      const id = await insertBooking();
      const before = await listWatchedBookings(runner, NOW);
      await db.query(change, [id]);
      expect(await anyBookingChanged(runner, before)).toBe(true);
    }
  });

  it("is not noticed when nothing changed", async () => {
    await insertBooking();
    const before = await listWatchedBookings(runner, NOW);
    expect(await anyBookingChanged(runner, before)).toBe(false);
    expect(await anyBookingChanged(runner, [])).toBe(false);
  });
});

/** The booking's own hold, as checkout leaves it: converted, carrying the same event id. */
async function insertHoldFor(bookingId: string, status = "converted"): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into slot_holds (slot_start, slot_end, order_id, calendar_event_id, expires_at, status)
     select scheduled_start, scheduled_end, order_id, calendar_event_id, scheduled_start, $2
       from bookings where id = $1
     returning id`,
    [bookingId, status],
  );
  return result.rows[0]!.id;
}

async function eventIdOf(table: "bookings" | "slot_holds", id: string) {
  const result = await db.query<{ calendar_event_id: string | null }>(
    `select calendar_event_id from ${table} where id = $1`,
    [id],
  );
  return result.rows[0]?.calendar_event_id;
}

describe("a booking whose event was restored from Deleted Items", () => {
  beforeEach(async () => {
    await db.query(`delete from slot_holds`);
  });

  it("follows the event to its new id, booking and hold together", async () => {
    const id = await insertBooking({ eventId: "evt-old" });
    const hold = await insertHoldFor(id);
    const adopted = await adoptRestoredEvents(
      runner,
      [{ bookingId: id, fromId: "evt-old", toId: "evt-new" }],
      NOW,
    );
    expect(adopted).toBe(1);
    expect(await eventIdOf("bookings", id)).toBe("evt-new");
    expect(await eventIdOf("slot_holds", hold)).toBe("evt-new");
  });

  it("leaves a booking alone that changed since the calendar was read", async () => {
    const changes = [
      `update bookings set calendar_event_id = 'evt-other' where id = $1`,
      `update bookings set status = 'cancelled' where id = $1`,
    ];
    for (const change of changes) {
      await db.query(`delete from slot_holds`);
      await db.query(`delete from bookings`);
      const id = await insertBooking({ eventId: "evt-old" });
      const hold = await insertHoldFor(id);
      await db.query(change, [id]);
      const adopted = await adoptRestoredEvents(
        runner,
        [{ bookingId: id, fromId: "evt-old", toId: "evt-new" }],
        NOW,
      );
      expect(adopted).toBe(0);
      expect(await eventIdOf("slot_holds", hold)).toBe("evt-old");
    }
  });

  it("touches no other order's hold", async () => {
    const id = await insertBooking({ eventId: "evt-old" });
    const other = await insertBooking({ eventId: "evt-old" });
    const otherHold = await insertHoldFor(other);
    await adoptRestoredEvents(runner, [{ bookingId: id, fromId: "evt-old", toId: "evt-new" }], NOW);
    expect(await eventIdOf("bookings", other)).toBe("evt-old");
    expect(await eventIdOf("slot_holds", otherHold)).toBe("evt-old");
  });
});

describe("the desk alert kind", () => {
  it("accepts calendar_event_changed and still refuses an unknown kind", async () => {
    await db.query(
      `insert into desk_alerts (kind, subject_key, first_raised_at)
       values ('calendar_event_changed', 'booking:x', now())`,
    );
    await expect(
      db.query(
        `insert into desk_alerts (kind, subject_key, first_raised_at)
         values ('something_else', 'booking:y', now())`,
      ),
    ).rejects.toThrow();
  });
});
