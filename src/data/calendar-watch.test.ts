import { describe, expect, it, vi } from "vitest";
import type { ExternalEvent } from "@/domain/scheduling/provider";
import {
  MAX_FOLLOW_UPS_PER_RUN,
  findCalendarProblems,
  looksMisconfigured,
  type WatchedBooking,
} from "./calendar-watch";

/**
 * The Outlook watch, the part that decides. A booked session whose calendar
 * event was deleted, cancelled or moved by hand is a problem for the desk;
 * one that still matches is not. An event restored from Deleted Items comes
 * back with a NEW id and the SAME Teams link (spike S1, 2026-10-16), so it is
 * recognised by the link. The calendar's list read does not carry the link
 * (also S1), so a candidate is read by its id.
 */

const LINK = "https://teams.example/meet/booking-a";
const A = { start: new Date("2026-10-20T15:00:00Z"), end: new Date("2026-10-20T16:30:00Z") };
const LATER = { start: new Date("2026-10-21T15:00:00Z"), end: new Date("2026-10-21T16:30:00Z") };

function booking(overrides: Partial<WatchedBooking> = {}): WatchedBooking {
  return {
    bookingId: "b-1",
    calendarEventId: "evt-a",
    start: A.start,
    end: A.end,
    meetingUrl: LINK,
    calendarMoveDue: false,
    ...overrides,
  };
}

function event(id: string, overrides: Partial<ExternalEvent> = {}): ExternalEvent {
  return {
    externalId: id,
    status: "confirmed",
    start: A.start,
    end: A.end,
    meetingUrl: LINK,
    ...overrides,
  };
}

/**
 * A calendar as Graph behaves: every event by id, and a list read over a
 * window that leaves the join link out.
 */
function calendar(events: readonly ExternalEvent[]) {
  const byId = new Map(events.map((e) => [e.externalId, e]));
  const reads: string[] = [];
  return {
    reads,
    eventsBetween: vi.fn((from: Date, to: Date) =>
      Promise.resolve(
        events.filter((e) => e.start < to && e.end > from).map((e) => ({ ...e, meetingUrl: null })),
      ),
    ),
    getEvent: vi.fn((id: string) => {
      reads.push(id);
      return Promise.resolve(byId.get(id) ?? null);
    }),
  };
}

const problemsOf = async (...args: Parameters<typeof findCalendarProblems>) =>
  (await findCalendarProblems(...args)).problems;

describe("a booking whose event still matches", () => {
  it("is fine, and costs one list read and no follow-up", async () => {
    const cal = calendar([event("evt-a")]);
    expect(await problemsOf([booking()], cal)).toEqual([]);
    expect(cal.eventsBetween).toHaveBeenCalledTimes(1);
    expect(cal.reads).toEqual([]);
  });

  it("is fine when the calendar's times carry stray milliseconds", async () => {
    const cal = calendar([
      event("evt-a", {
        start: new Date(A.start.getTime() + 400),
        end: new Date(A.end.getTime() + 999),
      }),
    ]);
    expect(await problemsOf([booking()], cal)).toEqual([]);
  });

  it("is fine after a restore from Deleted Items: new id, same times, same Teams link", async () => {
    const cal = calendar([event("evt-restored")]);
    expect(await problemsOf([booking()], cal)).toEqual([]);
    expect(cal.reads).toEqual(["evt-a", "evt-restored"]);
  });

  it("names the restored event, so the booking can follow it to its new id", async () => {
    const cal = calendar([event("evt-restored")]);
    expect(await findCalendarProblems([booking()], cal)).toEqual({
      problems: [],
      restored: [{ bookingId: "b-1", fromId: "evt-a", toId: "evt-restored" }],
    });
  });

  it("names nothing restored when the event never left", async () => {
    const cal = calendar([event("evt-a")]);
    expect((await findCalendarProblems([booking()], cal)).restored).toEqual([]);
  });

  it("asks nothing of the calendar when there is nothing to watch", async () => {
    const cal = calendar([]);
    expect(await problemsOf([], cal)).toEqual([]);
    expect(cal.eventsBetween).not.toHaveBeenCalled();
  });

  it("reads the window from the earliest start to the latest end, a session in progress included", async () => {
    const cal = calendar([event("evt-a"), event("evt-b", LATER)]);
    await problemsOf(
      [booking(), booking({ bookingId: "b-2", calendarEventId: "evt-b", ...LATER })],
      cal,
    );
    expect(cal.eventsBetween).toHaveBeenCalledWith(A.start, LATER.end);
  });
});

describe("a booking whose event was deleted or cancelled", () => {
  it("is gone when the stored id no longer resolves", async () => {
    const cal = calendar([]);
    expect(await problemsOf([booking()], cal)).toEqual([
      { bookingId: "b-1", kind: "gone", booked: A },
    ]);
  });

  it("is gone when the event is cancelled", async () => {
    const cal = calendar([event("evt-a", { status: "cancelled", meetingUrl: null })]);
    expect(await problemsOf([booking()], cal)).toEqual([
      { bookingId: "b-1", kind: "gone", booked: A },
    ]);
  });

  it("is still gone when a hand-made event sits at the same time with another Teams link", async () => {
    const cal = calendar([event("evt-new", { meetingUrl: "https://teams.example/meet/other" })]);
    expect(await problemsOf([booking()], cal)).toEqual([
      { bookingId: "b-1", kind: "gone", booked: A },
    ]);
  });

  it("is still gone when a personal event with no Teams link sits at the same time", async () => {
    const cal = calendar([event("evt-personal", { meetingUrl: null })]);
    expect(await problemsOf([booking()], cal)).toEqual([
      { bookingId: "b-1", kind: "gone", booked: A },
    ]);
  });

  it("never matches by link when the booking has no link on record", async () => {
    const cal = calendar([event("evt-restored")]);
    expect(await problemsOf([booking({ meetingUrl: null })], cal)).toEqual([
      { bookingId: "b-1", kind: "gone", booked: A },
    ]);
  });

  it("does not take another booking's own event as a restore", async () => {
    // Two bookings cannot share a time, but a stored id is never a restore candidate for another booking.
    const cal = calendar([event("evt-b")]);
    const problems = await problemsOf(
      [booking(), booking({ bookingId: "b-2", calendarEventId: "evt-b", meetingUrl: LINK })],
      cal,
    );
    expect(problems).toEqual([{ bookingId: "b-1", kind: "gone", booked: A }]);
  });
});

describe("a booking whose event was moved by hand", () => {
  it("is moved, with both times, when the event is in the window at another time", async () => {
    const shifted = {
      start: new Date("2026-10-20T16:00:00Z"),
      end: new Date("2026-10-20T17:30:00Z"),
    };
    const cal = calendar([event("evt-a", shifted), event("evt-b", LATER)]);
    const problems = await problemsOf(
      [booking(), booking({ bookingId: "b-2", calendarEventId: "evt-b", ...LATER })],
      cal,
    );
    expect(problems).toEqual([{ bookingId: "b-1", kind: "moved", booked: A, calendar: shifted }]);
  });

  it("is moved when the event went outside the window, found by reading it", async () => {
    const earlier = {
      start: new Date("2026-10-10T15:00:00Z"),
      end: new Date("2026-10-10T16:30:00Z"),
    };
    const cal = calendar([event("evt-a", earlier)]);
    expect(await problemsOf([booking()], cal)).toEqual([
      { bookingId: "b-1", kind: "moved", booked: A, calendar: earlier },
    ]);
    expect(cal.reads).toEqual(["evt-a"]);
  });

  it("is moved when only its end changed", async () => {
    const longer = { start: A.start, end: new Date("2026-10-20T17:00:00Z") };
    const cal = calendar([event("evt-a", longer)]);
    expect(await problemsOf([booking()], cal)).toEqual([
      { bookingId: "b-1", kind: "moved", booked: A, calendar: longer },
    ]);
  });
});

describe("failures are failures, never an answer", () => {
  it("lets a list read failure through", async () => {
    const cal = calendar([event("evt-a")]);
    cal.eventsBetween.mockRejectedValueOnce(new Error("Graph 503"));
    await expect(problemsOf([booking()], cal)).rejects.toThrow("Graph 503");
  });

  it("lets a follow-up failure through: a 401, 403 or 500 is not 'gone'", async () => {
    const cal = calendar([]);
    cal.getEvent.mockRejectedValueOnce(new Error("Graph 403"));
    await expect(problemsOf([booking()], cal)).rejects.toThrow("Graph 403");
  });

  it(`stops reading after ${MAX_FOLLOW_UPS_PER_RUN} follow-ups and counts the rest as gone`, async () => {
    const many = Array.from({ length: MAX_FOLLOW_UPS_PER_RUN + 5 }, (_, i) =>
      booking({
        bookingId: `b-${i}`,
        calendarEventId: `evt-${i}`,
        start: new Date(A.start.getTime() + i * 86_400_000),
        end: new Date(A.end.getTime() + i * 86_400_000),
      }),
    );
    const cal = calendar([]);
    const problems = await problemsOf(many, cal);
    expect(cal.reads).toHaveLength(MAX_FOLLOW_UPS_PER_RUN);
    expect(problems).toHaveLength(many.length);
    expect(problems.every((p) => p.kind === "gone")).toBe(true);
  });
});

describe("many events missing at once", () => {
  it("looks like the wrong mailbox, not a run of deletions", () => {
    expect(looksMisconfigured(4, 2)).toBe(true);
    expect(looksMisconfigured(10, 9)).toBe(true);
  });

  it("is ordinary below four bookings or under half missing", () => {
    expect(looksMisconfigured(3, 3)).toBe(false);
    expect(looksMisconfigured(10, 4)).toBe(false);
    expect(looksMisconfigured(0, 0)).toBe(false);
  });
});
