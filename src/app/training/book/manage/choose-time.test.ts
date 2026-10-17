import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { listPaidButUnscheduled } from "@/data/audit-events";
import type { QueryRunner } from "@/data/db";
import {
  SlotUnavailableError,
  type ExternalEvent,
  type HoldSlotInput,
  type SchedulingProvider,
  type TimeSlot,
} from "@/domain/scheduling/provider";
import { createManageToken } from "@/lib/manage-link";
import { addDays, addMinutes } from "@/lib/time";
import { MESSAGES, NO_TIME_YET, confirmMove, confirmNewTime, loadManageView } from "./flow";

/**
 * A paid booking that lost its time, given a new one from the link the desk
 * sends (KC B8), against the real migrations: the page offers any open time,
 * the choice goes through the same constraints and the same confirmation as
 * every booking, and it never counts as the customer's one move.
 */

const SECRET = "x".repeat(40);
const NOW = new Date("2027-05-01T08:00:00Z");

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

/** A paid order whose booking is waiting for a time, as the lost-slot path leaves it. */
async function seedWaiting(paymentStatus = "paid") {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`choose${n}@example.com`],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'claude-claude-code', 149900, $2) returning id`,
    [customer.rows[0]!.id, paymentStatus],
  );
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, customer_timezone)
     values ($1, 'claude-claude-code', 1, 'awaiting_schedule', 'Asia/Dubai') returning id`,
    [order.rows[0]!.id],
  );
  const bookingId = booking.rows[0]!.id;
  return {
    bookingId,
    orderId: order.rows[0]!.id,
    token: createManageToken({ bookingId, expiresAt: addDays(NOW, 7) }, SECRET),
    // A time of its own, two days apart from every other test's.
    target: new Date(Date.UTC(2027, 4, 3 + n * 2, 15)),
  };
}

const slot = (start: Date): TimeSlot => ({ start, end: addMinutes(start, 90) });

/** A calendar that blocks and confirms, recording the hold keys it was given. */
function fakeCalendar(
  over: {
    holdSlot?: (input: HoldSlotInput) => Promise<ExternalEvent>;
    confirmSlot?: (externalId: string) => Promise<ExternalEvent>;
  } = {},
) {
  const holds: HoldSlotInput[] = [];
  const calendar = {
    holdSlot:
      over.holdSlot ??
      ((input: HoldSlotInput) => {
        holds.push(input);
        return Promise.resolve({
          externalId: `evt_new${n}`,
          status: "tentative",
          start: input.slot.start,
          end: input.slot.end,
          meetingUrl: null,
        } satisfies ExternalEvent);
      }),
    confirmSlot:
      over.confirmSlot ??
      ((externalId: string) =>
        Promise.resolve({
          externalId,
          status: "confirmed",
          start: NOW,
          end: NOW,
          meetingUrl: `https://teams.example.test/${externalId}`,
        } satisfies ExternalEvent)),
    moveEvent: () => Promise.resolve(),
  } as unknown as SchedulingProvider;
  return { calendar, holds };
}

function deps(offered: readonly TimeSlot[], calendar = fakeCalendar().calendar) {
  let askedUntil: Date | null = null;
  return {
    transaction,
    now: NOW,
    secret: SECRET,
    offered: (_minutes: number, _now: Date, until: Date) => {
      askedUntil = until;
      return Promise.resolve(offered);
    },
    calendar,
    askedUntil: () => askedUntil,
  };
}

const bookingRow = async (id: string) =>
  (
    await db.query<{
      status: string;
      scheduled_start: Date | null;
      reschedule_count: number;
      meeting_url: string | null;
      calendar_event_id: string | null;
    }>(
      `select status, scheduled_start, reschedule_count, meeting_url, calendar_event_id
         from bookings where id = $1`,
      [id],
    )
  ).rows[0];

const holdsFor = async (orderId: string) =>
  (
    await db.query<{ status: string }>("select status from slot_holds where order_id = $1", [
      orderId,
    ])
  ).rows.map((r) => r.status);

const holdEvents = async (orderId: string) =>
  (
    await db.query<{ calendar_event_id: string | null }>(
      "select calendar_event_id from slot_holds where order_id = $1",
      [orderId],
    )
  ).rows.map((r) => r.calendar_event_id);

describe("the page for a paid booking that lost its time", () => {
  it("offers any open time from now, as far as the move window, with no time shown yet", async () => {
    const s = await seedWaiting();
    const d = deps([slot(s.target)]);

    const result = await loadManageView(s.token, d);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.mode).toBe("choose");
    expect(result.view.sessionTime).toBe(NO_TIME_YET);
    expect(result.view.notMovable).toBeNull();
    expect((result.view.days ?? []).flatMap((day) => day.slots.map((x) => x.isoStart))).toEqual([
      s.target.toISOString(),
    ]);
    expect(d.askedUntil()).toEqual(addDays(NOW, 90));
  });

  it("offers nothing for a waiting booking whose order is not fully paid", async () => {
    for (const status of ["pending", "partially_refunded"]) {
      const s = await seedWaiting(status);
      const result = await loadManageView(s.token, deps([slot(s.target)]));
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) expect(result.message).toContain("cannot be moved");
    }
  });
});

describe("confirmNewTime", () => {
  it("books the chosen time, confirms it on the calendar, and leaves the one move untouched", async () => {
    const s = await seedWaiting();
    const { calendar, holds } = fakeCalendar();

    const result = await confirmNewTime(
      { token: s.token, slotStart: s.target.toISOString() },
      deps([slot(s.target)], calendar),
    );

    expect(result.ok).toBe(true);
    const row = await bookingRow(s.bookingId);
    expect(row?.status).toBe("confirmed");
    expect(row?.scheduled_start).toEqual(s.target);
    expect(row?.reschedule_count).toBe(0);
    expect(row?.meeting_url).toContain("teams.example.test");
    expect(await holdsFor(s.orderId)).toEqual(["converted"]);
    // The paid hold knows its event, so a later withdrawal's release deletes it.
    expect(await holdEvents(s.orderId)).toEqual([row?.calendar_event_id]);
    // A key of its own: never the key of the event that was lost.
    expect(holds[0]?.holdReference).toBe(`booking:${s.bookingId}:${s.target.getTime()}`);

    const queued = await db.query<{ template_key: string }>(
      "select template_key from communication_log where booking_id = $1",
      [s.bookingId],
    );
    expect(queued.rows.map((r) => r.template_key)).toContain("booking_confirmation");

    const audit = await db.query<{ action: string }>(
      "select action from audit_events where subject = $1",
      [`booking:${s.bookingId}`],
    );
    expect(audit.rows.map((r) => r.action)).toContain("booking.time_chosen_after_loss");

    // And the desk alert has nothing left to say about this order.
    const waiting = await listPaidButUnscheduled(runner);
    expect(waiting.some((w) => w.orderId === s.orderId)).toBe(false);
  });

  it("after a new time, the customer still has their one free move", async () => {
    const s = await seedWaiting();
    await confirmNewTime(
      { token: s.token, slotStart: s.target.toISOString() },
      deps([slot(s.target)]),
    );
    const later = addDays(s.target, 3);
    const move = await confirmMove(
      { token: s.token, slotStart: later.toISOString() },
      deps([slot(later)]),
    );
    expect(move.ok).toBe(true);
    expect((await bookingRow(s.bookingId))?.reschedule_count).toBe(1);
  });

  it("refuses a second choice from the same link", async () => {
    const s = await seedWaiting();
    const d = deps([slot(s.target), slot(addDays(s.target, 1))]);
    await confirmNewTime({ token: s.token, slotStart: s.target.toISOString() }, d);

    const again = await confirmNewTime(
      { token: s.token, slotStart: addDays(s.target, 1).toISOString() },
      d,
    );

    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.message).toContain("already has its new time");
    expect((await bookingRow(s.bookingId))?.scheduled_start).toEqual(s.target);
  });

  it("refuses a time that is not on offer right now", async () => {
    const s = await seedWaiting();
    const result = await confirmNewTime(
      { token: s.token, slotStart: s.target.toISOString() },
      deps([]),
    );
    expect(result).toEqual({ ok: false, message: MESSAGES.TIME_GONE });
    expect((await bookingRow(s.bookingId))?.status).toBe("awaiting_schedule");
  });

  it("says the time has gone when another booking holds it, and changes nothing", async () => {
    const s = await seedWaiting();
    const other = await seedWaiting();
    await db.query(
      `insert into slot_holds (slot_start, slot_end, order_id, expires_at, status)
       values ($1, $2, $3, $1, 'converted')`,
      [s.target, addMinutes(s.target, 90), other.orderId],
    );

    const result = await confirmNewTime(
      { token: s.token, slotStart: s.target.toISOString() },
      deps([slot(s.target)]),
    );

    expect(result).toEqual({ ok: false, message: MESSAGES.TAKEN });
    expect((await bookingRow(s.bookingId))?.status).toBe("awaiting_schedule");
    expect(await holdsFor(s.orderId)).toEqual([]);
  });

  it("when the calendar refuses the time, the booking waits again and the time is given back", async () => {
    const s = await seedWaiting();
    const { calendar } = fakeCalendar({
      holdSlot: (input) => Promise.reject(new SlotUnavailableError(input.slot)),
    });

    const result = await confirmNewTime(
      { token: s.token, slotStart: s.target.toISOString() },
      deps([slot(s.target)], calendar),
    );

    expect(result).toEqual({ ok: false, message: MESSAGES.TAKEN });
    const row = await bookingRow(s.bookingId);
    expect(row?.status).toBe("awaiting_schedule");
    expect(row?.scheduled_start).toBeNull();
    expect(await holdsFor(s.orderId)).toEqual(["released"]);
  });

  it("when the calendar refuses after blocking, the released hold takes the event with it", async () => {
    const s = await seedWaiting();
    const { calendar } = fakeCalendar({
      confirmSlot: () => Promise.reject(new SlotUnavailableError(slot(s.target))),
    });

    const result = await confirmNewTime(
      { token: s.token, slotStart: s.target.toISOString() },
      deps([slot(s.target)], calendar),
    );

    expect(result).toEqual({ ok: false, message: MESSAGES.TAKEN });
    expect(await holdsFor(s.orderId)).toEqual(["released"]);
    // The release sweep deletes the events of released holds that name one.
    expect(await holdEvents(s.orderId)).toEqual([`evt_new${n}`]);
  });

  it("does not tell a cancelled booking it has a new time", async () => {
    const s = await seedWaiting();
    await db.query("update bookings set status = 'cancelled' where id = $1", [s.bookingId]);
    const result = await confirmNewTime(
      { token: s.token, slotStart: s.target.toISOString() },
      deps([slot(s.target)]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("cannot be moved");
      expect(result.message).not.toContain("new time");
    }
  });

  it("keeps the new time when the calendar is unreachable: the sweep confirms it", async () => {
    const s = await seedWaiting();
    const { calendar } = fakeCalendar({
      holdSlot: () => Promise.reject(new Error("ECONNRESET")),
    });

    const result = await confirmNewTime(
      { token: s.token, slotStart: s.target.toISOString() },
      deps([slot(s.target)], calendar),
    );

    expect(result.ok).toBe(true);
    const row = await bookingRow(s.bookingId);
    expect(row?.status).toBe("scheduled");
    expect(row?.scheduled_start).toEqual(s.target);
  });

  it("refuses a part-refunded order: only a fully paid one is confirmed", async () => {
    const s = await seedWaiting("partially_refunded");
    const result = await confirmNewTime(
      { token: s.token, slotStart: s.target.toISOString() },
      deps([slot(s.target)]),
    );
    expect(result.ok).toBe(false);
    expect((await bookingRow(s.bookingId))?.status).toBe("awaiting_schedule");
  });

  it("is not a way to move a confirmed booking", async () => {
    const s = await seedWaiting();
    await confirmNewTime(
      { token: s.token, slotStart: s.target.toISOString() },
      deps([slot(s.target)]),
    );
    const later = addDays(s.target, 2);
    const result = await confirmNewTime(
      { token: s.token, slotStart: later.toISOString() },
      deps([slot(later)]),
    );
    expect(result.ok).toBe(false);
    const row = await bookingRow(s.bookingId);
    expect(row?.scheduled_start).toEqual(s.target);
    expect(row?.reschedule_count).toBe(0);
  });

  it("refuses a link that is not valid", async () => {
    const s = await seedWaiting();
    const result = await confirmNewTime(
      { token: `${s.token}x`, slotStart: s.target.toISOString() },
      deps([slot(s.target)]),
    );
    expect(result.ok).toBe(false);
    expect((await bookingRow(s.bookingId))?.status).toBe("awaiting_schedule");
  });
});
