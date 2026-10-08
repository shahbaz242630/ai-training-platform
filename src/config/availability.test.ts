import { describe, it, expect } from "vitest";
import { AVAILABILITY, windowsForWeekday, type AvailabilityRules } from "./availability";
import { addDays, at, gstIsoDate, toGstParts, type Weekday } from "@/lib/time";
import { candidateSlots } from "@/domain/scheduling/rules";

/*
  Most of these tests check the SHAPE of the availability rules, which must
  hold whatever the hours become - and every one of these failures is silent
  in production. A window that ends before it starts simply offers nothing,
  and looks identical to a quiet week. One block below pins the founder's
  confirmed hours themselves.
*/

const MINUTES_IN_A_DAY = 24 * 60;

describe("the shipped availability rules", () => {
  it("has at least one window, or nothing can ever be booked", () => {
    expect(AVAILABILITY.windows.length).toBeGreaterThan(0);
  });

  it("has windows that start before they end", () => {
    for (const window of AVAILABILITY.windows) {
      expect(window.endMinutes).toBeGreaterThan(window.startMinutes);
    }
  });

  it("keeps every window inside a single day", () => {
    for (const window of AVAILABILITY.windows) {
      expect(window.startMinutes).toBeGreaterThanOrEqual(0);
      expect(window.endMinutes).toBeLessThanOrEqual(MINUTES_IN_A_DAY);
    }
  });

  it("uses valid weekdays", () => {
    for (const window of AVAILABILITY.windows) {
      expect(window.weekday).toBeGreaterThanOrEqual(0);
      expect(window.weekday).toBeLessThanOrEqual(6);
    }
  });

  it("has no two windows overlapping on the same day", () => {
    const byDay = new Map<Weekday, { startMinutes: number; endMinutes: number }[]>();
    for (const window of AVAILABILITY.windows) {
      byDay.set(window.weekday, [...(byDay.get(window.weekday) ?? []), window]);
    }
    for (const windows of byDay.values()) {
      const sorted = [...windows].toSorted((a, b) => a.startMinutes - b.startMinutes);
      for (let i = 1; i < sorted.length; i++) {
        expect(sorted[i]?.startMinutes).toBeGreaterThanOrEqual(sorted[i - 1]?.endMinutes ?? 0);
      }
    }
  });

  it("has a positive slot interval, or slot generation would not terminate", () => {
    expect(AVAILABILITY.slotIntervalMinutes).toBeGreaterThan(0);
  });

  it("has a non-negative buffer and a positive horizon", () => {
    expect(AVAILABILITY.bufferMinutes).toBeGreaterThanOrEqual(0);
    expect(AVAILABILITY.minimumNoticeHours).toBeGreaterThanOrEqual(0);
    expect(AVAILABILITY.bookingHorizonDays).toBeGreaterThan(0);
  });

  it("can fit the longest session we sell into at least one window", () => {
    // Every session in the catalogue runs 90 minutes. A window shorter than the
    // session it is meant to hold offers nothing at all, silently.
    const longestSessionMinutes = 90;
    const fits = AVAILABILITY.windows.some(
      (window) => window.endMinutes - window.startMinutes >= longestSessionMinutes,
    );
    expect(fits).toBe(true);
  });
});

describe("the founder's real hours (confirmed 2026-10-08)", () => {
  /*
    The one test that pins the hours themselves, because they are now a
    decision rather than a placeholder: two 90-minute sessions every evening,
    7:00-8:30pm and 9:00-10:30pm Dubai time, seven days a week, with the break
    between them. Change this test only when the founder changes his hours.
  */

  /** Monday 7 September 2026, 10:00 in Dubai. */
  const NOW = new Date("2026-09-07T06:00:00.000Z");
  const query = { from: NOW, to: addDays(NOW, 10), durationMinutes: 90 };

  function startsByDay(slots: readonly { start: Date }[]): Map<string, number[]> {
    const byDay = new Map<string, number[]>();
    for (const slot of slots) {
      const day = gstIsoDate(slot.start);
      byDay.set(day, [...(byDay.get(day) ?? []), toGstParts(slot.start).minutesOfDay]);
    }
    return byDay;
  }

  it("offers exactly 7pm and 9pm on every day of the week", () => {
    const byDay = startsByDay(candidateSlots(query, AVAILABILITY, NOW, []));
    // Tuesday 8 to Monday 14 September: seven whole days past the notice period.
    const week = ["08", "09", "10", "11", "12", "13", "14"].map((d) => `2026-09-${d}`);
    for (const day of week) {
      expect(byDay.get(day)).toEqual([at(19), at(21)]);
    }
  });

  it("still offers 9pm when 7pm is booked, so the break holds the buffer", () => {
    const sevenPm = {
      start: new Date("2026-09-10T15:00:00.000Z"),
      end: new Date("2026-09-10T16:30:00.000Z"),
    };
    const byDay = startsByDay(candidateSlots(query, AVAILABILITY, NOW, [sevenPm]));
    expect(byDay.get("2026-09-10")).toEqual([at(21)]);
  });
});

describe("windowsForWeekday", () => {
  const rules: AvailabilityRules = {
    windows: [
      { weekday: 1, startMinutes: at(18), endMinutes: at(21) },
      { weekday: 1, startMinutes: at(9), endMinutes: at(12) },
      { weekday: 6, startMinutes: at(10), endMinutes: at(13) },
    ],
    slotIntervalMinutes: 30,
    bufferMinutes: 0,
    minimumNoticeHours: 0,
    bookingHorizonDays: 30,
  };

  it("returns every window on that day", () => {
    expect(windowsForWeekday(rules, 1)).toHaveLength(2);
    expect(windowsForWeekday(rules, 6)).toHaveLength(1);
  });

  it("returns nothing for a day with no windows", () => {
    expect(windowsForWeekday(rules, 0)).toEqual([]);
  });
});
