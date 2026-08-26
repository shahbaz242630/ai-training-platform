import { describe, it, expect } from "vitest";
import { AVAILABILITY, windowsForWeekday, type AvailabilityRules } from "./availability";
import { at, type Weekday } from "@/lib/time";

/*
  These tests check the SHAPE of the availability rules, never the particular
  hours. The hours are a business decision and are currently placeholders; a
  test asserting "Saturday starts at 10:00" would have to be edited the day the
  founder picks his real hours, which teaches everyone to edit tests to make
  them pass.

  The shape, though, must hold whatever the hours become - and every one of
  these failures is silent in production. A window that ends before it starts
  simply offers nothing, and looks identical to a quiet week.
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
