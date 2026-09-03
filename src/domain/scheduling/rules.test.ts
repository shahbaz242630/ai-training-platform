import { describe, expect, it } from "vitest";
import type { AvailabilityRules } from "@/config/availability";
import { addDays, addMinutes, at, type Weekday } from "@/lib/time";
import { candidateSlots, conflictsWithBusy, isBookableSlot } from "./rules";

/**
 * The rules with busy times handed in from outside, which is how the real
 * calendar will use them. The in-memory provider's own tests cover the rules
 * through that provider; these cover the seam the real provider sits on.
 */

const MONDAY: Weekday = 1;
const SATURDAY: Weekday = 6;

const RULES: AvailabilityRules = {
  windows: [
    { weekday: MONDAY, startMinutes: at(18), endMinutes: at(21) },
    { weekday: SATURDAY, startMinutes: at(10), endMinutes: at(13) },
  ],
  slotIntervalMinutes: 30,
  bufferMinutes: 15,
  minimumNoticeHours: 24,
  bookingHorizonDays: 30,
};

/** Monday 7 September 2026, 10:00 in Dubai. */
const NOW = new Date("2026-09-07T06:00:00.000Z");
/** Saturday 12 September, 10:00 in Dubai - the first bookable slot under these rules. */
const SATURDAY_10 = {
  start: new Date("2026-09-12T06:00:00.000Z"),
  end: new Date("2026-09-12T07:30:00.000Z"),
};

const query = { from: NOW, to: addDays(NOW, 10), durationMinutes: 90 };

describe("candidateSlots", () => {
  it("offers the same grid whether or not anything is busy, minus the busy times", () => {
    const free = candidateSlots(query, RULES, NOW, []);
    const withBusy = candidateSlots(query, RULES, NOW, [SATURDAY_10]);

    expect(free.some((s) => s.start.getTime() === SATURDAY_10.start.getTime())).toBe(true);
    expect(withBusy.some((s) => s.start.getTime() === SATURDAY_10.start.getTime())).toBe(false);
    expect(withBusy.length).toBeLessThan(free.length);
  });

  it("treats a busy time that only touches the buffer as a conflict", () => {
    // Ends fifteen minutes before the slot would start: inside the buffer.
    const justBefore = {
      start: addMinutes(SATURDAY_10.start, -60),
      end: addMinutes(SATURDAY_10.start, -10),
    };
    const slots = candidateSlots(query, RULES, NOW, [justBefore]);
    expect(slots.some((s) => s.start.getTime() === SATURDAY_10.start.getTime())).toBe(false);
  });

  it("is unaffected by a busy time outside the window", () => {
    const farAway = { start: addDays(NOW, 200), end: addDays(NOW, 201) };
    expect(candidateSlots(query, RULES, NOW, [farAway])).toEqual(
      candidateSlots(query, RULES, NOW, []),
    );
  });
});

describe("isBookableSlot", () => {
  it("accepts an offered slot and refuses it once something busy overlaps", () => {
    expect(isBookableSlot(SATURDAY_10, RULES, NOW, [])).toBe(true);
    expect(isBookableSlot(SATURDAY_10, RULES, NOW, [SATURDAY_10])).toBe(false);
  });

  it("refuses a slot the grid would never offer, however free the calendar is", () => {
    const threeAm = {
      start: new Date("2026-09-12T23:00:00.000Z"),
      end: new Date("2026-09-13T00:30:00.000Z"),
    };
    expect(isBookableSlot(threeAm, RULES, NOW, [])).toBe(false);
  });
});

describe("conflictsWithBusy", () => {
  it("pads every busy interval by the buffer on both sides", () => {
    const slot = SATURDAY_10;
    const endsRightBefore = {
      start: addMinutes(slot.start, -90),
      end: addMinutes(slot.start, -14),
    };
    const endsWellBefore = { start: addMinutes(slot.start, -90), end: addMinutes(slot.start, -16) };
    expect(conflictsWithBusy(slot, [endsRightBefore], 15)).toBe(true);
    expect(conflictsWithBusy(slot, [endsWellBefore], 15)).toBe(false);
    expect(conflictsWithBusy(slot, [], 15)).toBe(false);
  });
});
