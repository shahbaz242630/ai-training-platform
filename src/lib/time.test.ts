import { describe, it, expect } from "vitest";
import {
  GST_OFFSET_MINUTES,
  GST_TIMEZONE,
  addDays,
  addMinutes,
  at,
  gstDayStartUtc,
  gstTimeOnDayUtc,
  intervalsOverlap,
  padInterval,
  toGstParts,
} from "./time";

describe("Gulf Standard Time", () => {
  it("is four hours ahead of UTC", () => {
    expect(GST_OFFSET_MINUTES).toBe(240);
    expect(GST_TIMEZONE).toBe("Asia/Dubai");
  });

  it("reads a UTC instant as the Dubai wall clock", () => {
    const parts = toGstParts(new Date("2026-09-10T06:00:00.000Z"));
    expect(parts.minutesOfDay).toBe(at(10)); // 06:00 UTC is 10:00 in Dubai
    expect(parts.year).toBe(2026);
    expect(parts.month).toBe(9);
    expect(parts.day).toBe(10);
  });

  it("uses 1-12 for months, not the JavaScript 0-11", () => {
    expect(toGstParts(new Date("2026-01-15T12:00:00.000Z")).month).toBe(1);
    expect(toGstParts(new Date("2026-12-15T12:00:00.000Z")).month).toBe(12);
  });

  // The case the fixed offset exists to get right: late UTC evening is already
  // the next calendar day in Dubai.
  it("rolls to the next Dubai day after 20:00 UTC", () => {
    const parts = toGstParts(new Date("2026-09-10T20:30:00.000Z"));
    expect(parts.day).toBe(11);
    expect(parts.minutesOfDay).toBe(at(0, 30));
  });

  it("still reports the previous Dubai day just before that", () => {
    const parts = toGstParts(new Date("2026-09-10T19:59:00.000Z"));
    expect(parts.day).toBe(10);
    expect(parts.minutesOfDay).toBe(at(23, 59));
  });

  it("reports the weekday in Dubai, not in UTC", () => {
    // 20:30 UTC on Saturday is already Sunday in Dubai.
    expect(toGstParts(new Date("2026-09-12T20:30:00.000Z")).weekday).toBe(0);
    expect(toGstParts(new Date("2026-09-12T19:30:00.000Z")).weekday).toBe(6);
  });

  // No daylight saving in the UAE, so the offset is the same in both halves of
  // the year. This test is what would fail if anyone "improved" the offset into
  // something DST-aware for the wrong zone.
  it("uses the same offset in January and July", () => {
    expect(toGstParts(new Date("2026-01-10T06:00:00.000Z")).minutesOfDay).toBe(at(10));
    expect(toGstParts(new Date("2026-07-10T06:00:00.000Z")).minutesOfDay).toBe(at(10));
  });
});

describe("gstDayStartUtc and gstTimeOnDayUtc", () => {
  it("finds the UTC instant when the Dubai day began", () => {
    // Midnight in Dubai is 20:00 UTC the previous day.
    expect(gstDayStartUtc(new Date("2026-09-10T06:00:00.000Z"))).toEqual(
      new Date("2026-09-09T20:00:00.000Z"),
    );
  });

  it("is stable for any instant within the same Dubai day", () => {
    const morning = gstDayStartUtc(new Date("2026-09-10T04:00:00.000Z"));
    const evening = gstDayStartUtc(new Date("2026-09-10T19:00:00.000Z"));
    expect(morning).toEqual(evening);
  });

  it("places a Dubai time of day on that day as a UTC instant", () => {
    const dayStart = gstDayStartUtc(new Date("2026-09-10T06:00:00.000Z"));
    // 18:00 in Dubai is 14:00 UTC.
    expect(gstTimeOnDayUtc(dayStart, at(18))).toEqual(new Date("2026-09-10T14:00:00.000Z"));
  });

  it("round-trips a wall-clock time back to the same wall-clock time", () => {
    const dayStart = gstDayStartUtc(new Date("2026-03-01T09:00:00.000Z"));
    const instant = gstTimeOnDayUtc(dayStart, at(21, 30));
    expect(toGstParts(instant).minutesOfDay).toBe(at(21, 30));
  });
});

describe("at", () => {
  it("turns a readable time into minutes since midnight", () => {
    expect(at(0)).toBe(0);
    expect(at(9, 30)).toBe(570);
    expect(at(23, 59)).toBe(1439);
  });
});

describe("addMinutes and addDays", () => {
  const base = new Date("2026-09-10T06:00:00.000Z");

  it("moves forward and backward", () => {
    expect(addMinutes(base, 90)).toEqual(new Date("2026-09-10T07:30:00.000Z"));
    expect(addMinutes(base, -60)).toEqual(new Date("2026-09-10T05:00:00.000Z"));
    expect(addDays(base, 2)).toEqual(new Date("2026-09-12T06:00:00.000Z"));
  });

  it("does not mutate the instant it was given", () => {
    addMinutes(base, 90);
    expect(base).toEqual(new Date("2026-09-10T06:00:00.000Z"));
  });
});

describe("intervalsOverlap", () => {
  const start = new Date("2026-09-10T06:00:00.000Z");
  const end = new Date("2026-09-10T07:30:00.000Z");
  const interval = { start, end };

  it("does not overlap one that starts exactly when this one ends", () => {
    expect(intervalsOverlap(interval, { start: end, end: addMinutes(end, 90) })).toBe(false);
  });

  it("does not overlap one that ends exactly when this one starts", () => {
    expect(intervalsOverlap(interval, { start: addMinutes(start, -90), end: start })).toBe(false);
  });

  it("overlaps one that starts partway through", () => {
    expect(
      intervalsOverlap(interval, { start: addMinutes(start, 30), end: addMinutes(end, 30) }),
    ).toBe(true);
  });

  it("overlaps one entirely inside it", () => {
    expect(
      intervalsOverlap(interval, { start: addMinutes(start, 10), end: addMinutes(start, 20) }),
    ).toBe(true);
  });

  it("overlaps one that entirely contains it", () => {
    expect(
      intervalsOverlap(interval, { start: addMinutes(start, -10), end: addMinutes(end, 10) }),
    ).toBe(true);
  });

  it("does not overlap one on another day", () => {
    expect(
      intervalsOverlap(interval, {
        start: new Date("2026-09-11T06:00:00.000Z"),
        end: new Date("2026-09-11T07:30:00.000Z"),
      }),
    ).toBe(false);
  });
});

describe("padInterval", () => {
  const interval = {
    start: new Date("2026-09-10T06:00:00.000Z"),
    end: new Date("2026-09-10T07:30:00.000Z"),
  };

  it("grows an interval by the same amount at both ends", () => {
    const padded = padInterval(interval, 15);
    expect(padded.start).toEqual(new Date("2026-09-10T05:45:00.000Z"));
    expect(padded.end).toEqual(new Date("2026-09-10T07:45:00.000Z"));
  });

  it("turns an adjacent interval into an overlapping one, which is what a buffer is for", () => {
    const adjacent = { start: interval.end, end: addMinutes(interval.end, 90) };
    expect(intervalsOverlap(interval, adjacent)).toBe(false);
    expect(intervalsOverlap(padInterval(interval, 15), adjacent)).toBe(true);
  });

  it("leaves the interval alone when the buffer is zero", () => {
    expect(padInterval(interval, 0)).toEqual(interval);
  });
});
