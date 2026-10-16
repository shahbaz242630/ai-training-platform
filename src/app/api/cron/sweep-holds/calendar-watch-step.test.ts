import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { QueryRunner } from "@/data/db";
import { MockEmailProvider } from "@/domain/messaging/mock-provider";
import type { ExternalEvent } from "@/domain/scheduling/provider";
import { resetLogSink, setLogSink, type LogRecord } from "@/lib/logger";
import { watchCalendar, type CalendarWatchDeps } from "./calendar-watch-step";

/**
 * The Outlook watch as the sweep runs it: read the bookings, read the
 * calendar, tell the desk. The rule that matters most: when the calendar
 * cannot be read properly, NOTHING is reconciled, because reconciling with
 * an empty or partial answer would close real alerts without anyone acting.
 */

let db: PGlite;
let mail: MockEmailProvider;
let logs: LogRecord[];
const NOW = new Date("2026-10-16T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const DESK = "desk@example.com";
let n = 0;

beforeAll(async () => {
  db = await PGlite.create();
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.query(`delete from bookings`);
  await db.query(`delete from desk_alerts`);
  mail = new MockEmailProvider();
  logs = [];
  setLogSink((r) => {
    logs.push(r);
  });
});

afterEach(() => {
  resetLogSink();
});

interface Booked {
  readonly id: string;
  readonly eventId: string;
  readonly link: string;
  readonly start: Date;
  readonly end: Date;
}

async function confirmedBooking(): Promise<Booked> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Europe/London') returning id`,
    [`watchstep${n}@example.com`],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'ai-foundations', 129900, 'paid') returning id`,
    [customer.rows[0]!.id],
  );
  const start = new Date(NOW.getTime() + n * DAY);
  const end = new Date(start.getTime() + 90 * 60_000);
  const eventId = `evt-${n}`;
  const link = `https://teams.example/meet/${n}`;
  const row = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end,
                           customer_timezone, calendar_event_id, meeting_url, updated_at)
     values ($1, 'ai-foundations', 1, 'confirmed', $2, $3, 'Europe/London', $4, $5, $6)
     returning id`,
    [order.rows[0]!.id, start, end, eventId, link, NOW],
  );
  return { id: row.rows[0]!.id, eventId, link, start, end };
}

const eventFor = (b: Booked, overrides: Partial<ExternalEvent> = {}): ExternalEvent => ({
  externalId: b.eventId,
  status: "confirmed",
  start: b.start,
  end: b.end,
  meetingUrl: b.link,
  ...overrides,
});

type Calendar = ReturnType<CalendarWatchDeps["calendar"]>;

/** A calendar holding these events, read the way Graph reads it. */
function calendarOf(events: readonly ExternalEvent[]): Calendar {
  const byId = new Map(events.map((e) => [e.externalId, e]));
  return {
    eventsBetween: (from, to) =>
      Promise.resolve(
        events.filter((e) => e.start < to && e.end > from).map((e) => ({ ...e, meetingUrl: null })),
      ),
    getEvent: (id) => Promise.resolve(byId.get(id) ?? null),
  };
}

function deps(calendar: () => Calendar, overrides: Partial<CalendarWatchDeps> = {}) {
  return {
    transaction: <T>(work: (r: QueryRunner) => Promise<T>) =>
      db.transaction((tx) => work(tx as unknown as QueryRunner)),
    calendar,
    email: () => mail,
    clock: () => NOW,
    deskAddress: DESK,
    ...overrides,
  } satisfies CalendarWatchDeps;
}

async function openAlerts() {
  const result = await db.query<{ subject_key: string }>(
    `select subject_key from desk_alerts
      where kind = 'calendar_event_changed' and resolved_at is null order by subject_key`,
  );
  return result.rows.map((r) => r.subject_key);
}

const errors = () => logs.filter((l) => l.level === "error").map((l) => l.message);

describe("when the calendar matches", () => {
  it("tells nobody and says how many it checked", async () => {
    const b = await confirmedBooking();
    const report = await watchCalendar(deps(() => calendarOf([eventFor(b)])));
    expect(report).toEqual({
      checked: 1,
      gone: 0,
      moved: 0,
      deskAlerts: { raised: 0, reminded: 0, resolved: 0, failed: 0 },
    });
    expect(mail.sent).toEqual([]);
  });
});

describe("when an event was deleted or moved", () => {
  it("emails the desk once, about that booking, and keeps the alert open", async () => {
    const b = await confirmedBooking();
    const report = await watchCalendar(deps(() => calendarOf([])));
    expect(report).toMatchObject({ checked: 1, gone: 1, moved: 0 });
    expect(mail.sent.map((m) => m.to)).toEqual([DESK]);
    expect(mail.sent[0]?.subject).toMatch(/^Session missing from the calendar: booking /);
    expect(await openAlerts()).toEqual([`booking:${b.id}`]);

    await watchCalendar(deps(() => calendarOf([])));
    expect(mail.sent).toHaveLength(1);
  });

  it("says 'moved' when the event shows another time", async () => {
    const b = await confirmedBooking();
    const shifted = eventFor(b, {
      start: new Date(b.start.getTime() + 60 * 60_000),
      end: new Date(b.end.getTime() + 60 * 60_000),
    });
    const report = await watchCalendar(deps(() => calendarOf([shifted])));
    expect(report).toMatchObject({ gone: 0, moved: 1 });
    expect(mail.sent[0]?.subject).toMatch(/^Session moved in the calendar only: /);
  });

  it("closes the alert quietly once the event is restored from Deleted Items", async () => {
    const b = await confirmedBooking();
    await watchCalendar(deps(() => calendarOf([])));
    const restored = eventFor(b, { externalId: "evt-restored-new-id" });
    const report = await watchCalendar(deps(() => calendarOf([restored])));
    expect(report).toMatchObject({ gone: 0, deskAlerts: { resolved: 1 } });
    expect(await openAlerts()).toEqual([]);
    expect(mail.sent).toHaveLength(1);
  });
});

describe("when the calendar cannot be read properly, nothing is closed", () => {
  async function withOpenAlert() {
    const b = await confirmedBooking();
    await watchCalendar(deps(() => calendarOf([])));
    expect(await openAlerts()).toEqual([`booking:${b.id}`]);
    mail = new MockEmailProvider();
    return b;
  }

  it("a list read that fails", async () => {
    await withOpenAlert();
    const broken: Calendar = {
      eventsBetween: () => Promise.reject(new Error("Graph 503")),
      getEvent: () => Promise.resolve(null),
    };
    const report = await watchCalendar(deps(() => broken));
    expect(report).toEqual({ error: "calendar could not be read" });
    expect(await openAlerts()).toHaveLength(1);
    expect(mail.sent).toEqual([]);
    expect(errors()).toContain("the Outlook watch could not read the calendar; it will run again");
  });

  it("a follow-up read that fails", async () => {
    await withOpenAlert();
    const broken: Calendar = {
      eventsBetween: () => Promise.resolve([]),
      getEvent: () => Promise.reject(new Error("Graph 403")),
    };
    expect(await watchCalendar(deps(() => broken))).toEqual({
      error: "calendar could not be read",
    });
    expect(await openAlerts()).toHaveLength(1);
  });

  it("a calendar that is not configured", async () => {
    await withOpenAlert();
    const report = await watchCalendar(
      deps(() => {
        throw new Error("MS_CLIENT_SECRET is not configured");
      }),
    );
    expect(report).toEqual({ error: "calendar not configured" });
    expect(await openAlerts()).toHaveLength(1);
  });

  it("a read that runs past the deadline", async () => {
    await withOpenAlert();
    const hanging: Calendar = {
      eventsBetween: () => new Promise(() => undefined),
      getEvent: () => Promise.resolve(null),
    };
    const report = await watchCalendar(deps(() => hanging, { deadlineMs: 20 }));
    expect(report).toEqual({ error: "calendar could not be read" });
    expect(await openAlerts()).toHaveLength(1);
  });

  it("most events missing at once: the wrong mailbox, not a run of deletions", async () => {
    await withOpenAlert();
    for (let i = 0; i < 3; i += 1) await confirmedBooking();
    const report = await watchCalendar(deps(() => calendarOf([])));
    expect(report).toEqual({ error: "calendar looks misconfigured" });
    expect(mail.sent).toEqual([]);
    expect(await openAlerts()).toHaveLength(1);
    expect(errors().some((m) => m.startsWith("THE OUTLOOK WATCH SEES MOST EVENTS MISSING"))).toBe(
      true,
    );
  });

  it("a booking that changed while the calendar was read waits for the next run", async () => {
    const b = await withOpenAlert();
    const racing: Calendar = {
      eventsBetween: async () => {
        await db.query(`update bookings set calendar_move_due = true where id = $1`, [b.id]);
        return [];
      },
      getEvent: () => Promise.resolve(null),
    };
    const report = await watchCalendar(deps(() => racing));
    expect(report).toEqual({ skipped: "a booking changed during the check" });
    expect(await openAlerts()).toHaveLength(1);
    expect(mail.sent).toEqual([]);
  });
});

describe("with nothing to watch", () => {
  it("needs no calendar, and closes alerts whose sessions have passed", async () => {
    await db.query(
      `insert into desk_alerts (kind, subject_key, first_raised_at, last_sent_at, sends)
       values ('calendar_event_changed', 'booking:old', $1, $1, 1)`,
      [NOW],
    );
    const report = await watchCalendar(
      deps(() => {
        throw new Error("must not be asked");
      }),
    );
    expect(report).toEqual({
      checked: 0,
      gone: 0,
      moved: 0,
      deskAlerts: { raised: 0, reminded: 0, resolved: 1, failed: 0 },
    });
    expect(await openAlerts()).toEqual([]);
  });
});

describe("logs", () => {
  it("never carry the customer's name or email address", async () => {
    await confirmedBooking();
    await watchCalendar(
      deps(() => ({
        eventsBetween: () => Promise.reject(new Error("Graph 503")),
        getEvent: () => Promise.resolve(null),
      })),
    );
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain("Amina");
    expect(logged).not.toContain("@example.com");
  });
});
