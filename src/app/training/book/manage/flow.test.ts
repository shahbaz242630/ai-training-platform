import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QueryRunner } from "@/data/db";
import { EventNotFoundError, type TimeSlot } from "@/domain/scheduling/provider";
import { resetLogSink, setLogSink, type LogRecord } from "@/lib/logger";
import { createManageToken } from "@/lib/manage-link";
import { addDays, addMinutes } from "@/lib/time";
import {
  LINK_MESSAGE,
  MESSAGES,
  MISSING_EVENT_ALARM,
  confirmMove,
  loadManageView,
  type ManageDeps,
} from "./flow";

/**
 * The manage page's decisions against the real migrations: who the link
 * identifies, which times are offered, and that a move is decided again on
 * the server at the moment it is confirmed.
 */

const SECRET = "a-test-secret-that-is-long-enough-1234";

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

const transaction = <T>(work: (r: QueryRunner) => Promise<T>): Promise<T> => work(runner);

async function seed(over: { rescheduleCount?: number } = {}) {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`manage${n}@example.com`],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid') returning id`,
    [customer.rows[0]!.id],
  );
  // Ten days apart: the moves below go three days on, and must not land on another booking.
  const start = new Date(Date.UTC(2027, 2, 1 + n * 10, 15));
  const end = addMinutes(start, 90);
  await db.query(
    `insert into slot_holds (slot_start, slot_end, order_id, calendar_event_id, expires_at, status)
     values ($1, $2, $3, $4, $1, 'converted')`,
    [start, end, order.rows[0]!.id, `evt_m${n}`],
  );
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start,
                           scheduled_end, customer_timezone, calendar_event_id, reschedule_count)
     values ($1, 'claude-claude-code', 1, 'confirmed', $2, $3, 'Asia/Dubai', $4, $5)
     returning id`,
    [order.rows[0]!.id, start, end, `evt_m${n}`, over.rescheduleCount ?? 0],
  );
  const bookingId = booking.rows[0]!.id;
  return { bookingId, start, token: createManageToken({ bookingId, expiresAt: start }, SECRET) };
}

const slot = (start: Date): TimeSlot => ({ start, end: addMinutes(start, 90) });

function deps(
  now: Date,
  offered: readonly TimeSlot[],
): ManageDeps & {
  calendar: { moveEvent: (id: string, s: TimeSlot) => Promise<void> };
  moved: string[];
} {
  const moved: string[] = [];
  return {
    transaction,
    now,
    secret: SECRET,
    offered: () => Promise.resolve(offered),
    calendar: {
      moveEvent: (id) => {
        moved.push(id);
        return Promise.resolve();
      },
    },
    moved,
  };
}

describe("loadManageView", () => {
  it("shows the booking and only the times it may move to", async () => {
    const s = await seed();
    const now = addDays(s.start, -5);
    const inside = addDays(s.start, 3);
    const beyond = addDays(s.start, 91);

    const result = await loadManageView(
      s.token,
      deps(now, [slot(s.start), slot(inside), slot(beyond)]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.notMovable).toBeNull();
    const offered = (result.view.days ?? []).flatMap((d) => d.slots.map((x) => x.isoStart));
    expect(offered).toEqual([inside.toISOString()]);
    expect(result.view.sessionTitle.length).toBeGreaterThan(0);
  });

  it("looks for times as far as 90 days after the original session, not just 60 days ahead", async () => {
    const s = await seed();
    let asked: Date | null = null;
    const d = {
      ...deps(addDays(s.start, -5), []),
      offered: (_minutes: number, _now: Date, until: Date) => {
        asked = until;
        return Promise.resolve([]);
      },
    };

    await loadManageView(s.token, d);

    expect(asked).toEqual(addMinutes(addDays(s.start, 90), 90));
  });

  it("says why a booking that was already moved cannot be moved again", async () => {
    const s = await seed({ rescheduleCount: 1 });
    const result = await loadManageView(s.token, deps(addDays(s.start, -5), []));
    expect(result).toMatchObject({ ok: true, view: { days: null } });
    if (result.ok) expect(result.view.notMovable).toContain("already been moved once");
  });

  it("says why a session inside the last 24 hours cannot be moved", async () => {
    const s = await seed();
    const result = await loadManageView(s.token, deps(addMinutes(s.start, -60), []));
    if (result.ok) expect(result.view.notMovable).toContain("less than 24 hours");
  });

  it("refuses a link that is not valid", async () => {
    const s = await seed();
    expect(await loadManageView(`${s.token}x`, deps(addDays(s.start, -5), []))).toEqual({
      ok: false,
      message: LINK_MESSAGE(),
    });
  });
});

describe("confirmMove", () => {
  it("moves the booking to the chosen time and moves the calendar event straight away", async () => {
    const s = await seed();
    const now = addDays(s.start, -5);
    const target = addDays(s.start, 3);
    const d = deps(now, [slot(target)]);

    const result = await confirmMove({ token: s.token, slotStart: target.toISOString() }, d);

    expect(result.ok).toBe(true);
    expect(d.moved).toEqual([`evt_m${n}`]);
    const row = await db.query<{ scheduled_start: Date; reschedule_count: number }>(
      "select scheduled_start, reschedule_count from bookings where id = $1",
      [s.bookingId],
    );
    expect(row.rows[0]).toEqual({ scheduled_start: target, reschedule_count: 1 });
  });

  it("refuses a time that is not one we would offer, and changes nothing", async () => {
    const s = await seed();
    const now = addDays(s.start, -5);
    const result = await confirmMove(
      { token: s.token, slotStart: addDays(s.start, 3).toISOString() },
      deps(now, []),
    );
    expect(result).toEqual({ ok: false, message: MESSAGES.TIME_GONE });
    const row = await db.query<{ reschedule_count: number }>(
      "select reschedule_count from bookings where id = $1",
      [s.bookingId],
    );
    expect(row.rows[0]?.reschedule_count).toBe(0);
  });

  it("refuses a link for another booking's time it cannot prove it owns", async () => {
    const s = await seed();
    const expired = createManageToken(
      { bookingId: s.bookingId, expiresAt: addDays(s.start, -6) },
      SECRET,
    );
    const result = await confirmMove(
      { token: expired, slotStart: addDays(s.start, 3).toISOString() },
      deps(addDays(s.start, -5), [slot(addDays(s.start, 3))]),
    );
    expect(result).toEqual({ ok: false, message: LINK_MESSAGE() });
  });

  it("tells the customer when someone else took the time first", async () => {
    const taken = await seed();
    const mover = await seed();
    const result = await confirmMove(
      { token: mover.token, slotStart: taken.start.toISOString() },
      deps(addDays(mover.start, -30), [slot(taken.start)]),
    );
    expect(result).toEqual({ ok: false, message: MESSAGES.TAKEN });
  });

  it("raises an alarm straight away when the moved session's event has vanished", async () => {
    const logs: LogRecord[] = [];
    setLogSink((r) => {
      logs.push(r);
    });
    try {
      const s = await seed();
      const target = addDays(s.start, 3);
      const d = {
        ...deps(addDays(s.start, -5), [slot(target)]),
        calendar: { moveEvent: () => Promise.reject(new EventNotFoundError("evt_gone")) },
      };

      expect((await confirmMove({ token: s.token, slotStart: target.toISOString() }, d)).ok).toBe(
        true,
      );
      expect(logs.some((l) => l.level === "error" && l.message === MISSING_EVENT_ALARM)).toBe(true);
    } finally {
      resetLogSink();
    }
  });

  it("tries once more when the database settles a race with a deadlock", async () => {
    const s = await seed();
    const target = addDays(s.start, 3);
    let calls = 0;
    const flaky = <T>(work: (r: QueryRunner) => Promise<T>): Promise<T> => {
      calls += 1;
      // The second call is the move itself: fail it once, as a deadlock would.
      if (calls === 2)
        return Promise.reject(Object.assign(new Error("deadlock"), { code: "40P01" }));
      return work(runner);
    };
    const d = { ...deps(addDays(s.start, -5), [slot(target)]), transaction: flaky };

    expect((await confirmMove({ token: s.token, slotStart: target.toISOString() }, d)).ok).toBe(
      true,
    );
  });

  it("keeps the move when the calendar is unreachable: the sweep finishes it", async () => {
    const s = await seed();
    const target = addDays(s.start, 3);
    const d = {
      ...deps(addDays(s.start, -5), [slot(target)]),
      calendar: { moveEvent: () => Promise.reject(new Error("ECONNRESET")) },
    };

    expect((await confirmMove({ token: s.token, slotStart: target.toISOString() }, d)).ok).toBe(
      true,
    );
    const row = await db.query<{ calendar_move_due: boolean }>(
      "select calendar_move_due from bookings where id = $1",
      [s.bookingId],
    );
    expect(row.rows[0]?.calendar_move_due).toBe(true);
  });

  it("refuses anything that is not a link and a time", async () => {
    const s = await seed();
    expect((await confirmMove({ token: s.token }, deps(new Date(), []))).ok).toBe(false);
    expect(
      (await confirmMove({ token: s.token, slotStart: "tomorrow", extra: 1 }, deps(new Date(), [])))
        .ok,
    ).toBe(false);
  });
});
