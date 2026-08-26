import { describe, it, expect } from "vitest";
import {
  DEFAULT_HOLD_TTL_MINUTES,
  SlotHoldShapeError,
  convertHold,
  createSlotHold,
  expireHold,
  findBlockingHold,
  hasExpired,
  isHoldActive,
  isSlotAvailable,
  releaseHold,
  sweepExpiredHolds,
  type SlotHold,
} from "./slot-hold";
import { InvalidTransitionError } from "./transitions";

const NOW = new Date("2026-09-01T10:00:00.000Z");
const SLOT_START = new Date("2026-09-10T06:00:00.000Z");
const SLOT_END = new Date("2026-09-10T07:30:00.000Z");

const minutesAfter = (from: Date, minutes: number) => new Date(from.getTime() + minutes * 60_000);

const aHold = (overrides: Partial<SlotHold> = {}): SlotHold => ({
  ...createSlotHold({
    id: "hold_1",
    slotStart: SLOT_START,
    slotEnd: SLOT_END,
    calendarEventId: "evt_tentative",
    now: NOW,
  }),
  ...overrides,
});

describe("createSlotHold", () => {
  it("expires fifteen minutes out by default", () => {
    const hold = createSlotHold({
      id: "hold_1",
      slotStart: SLOT_START,
      slotEnd: SLOT_END,
      now: NOW,
    });
    expect(DEFAULT_HOLD_TTL_MINUTES).toBe(15);
    expect(hold.expiresAt).toEqual(minutesAfter(NOW, 15));
    expect(hold.status).toBe("held");
    expect(hold.orderId).toBeNull();
  });

  it("accepts a configured lifetime", () => {
    const hold = createSlotHold({
      id: "hold_1",
      slotStart: SLOT_START,
      slotEnd: SLOT_END,
      ttlMinutes: 5,
      now: NOW,
    });
    expect(hold.expiresAt).toEqual(minutesAfter(NOW, 5));
  });

  it("refuses a slot that ends before it starts", () => {
    expect(() =>
      createSlotHold({ id: "h", slotStart: SLOT_END, slotEnd: SLOT_START, now: NOW }),
    ).toThrow(SlotHoldShapeError);
  });

  it("refuses a lifetime that would never block anything", () => {
    expect(() =>
      createSlotHold({
        id: "h",
        slotStart: SLOT_START,
        slotEnd: SLOT_END,
        ttlMinutes: 0,
        now: NOW,
      }),
    ).toThrow(SlotHoldShapeError);
    expect(() =>
      createSlotHold({
        id: "h",
        slotStart: SLOT_START,
        slotEnd: SLOT_END,
        ttlMinutes: Number.NaN,
        now: NOW,
      }),
    ).toThrow(SlotHoldShapeError);
  });
});

describe("hasExpired and isHoldActive", () => {
  it("is not expired a minute before its deadline", () => {
    expect(hasExpired(aHold(), minutesAfter(NOW, 14))).toBe(false);
  });

  it("is expired exactly on its deadline, not a moment after", () => {
    expect(hasExpired(aHold(), minutesAfter(NOW, 15))).toBe(true);
  });

  it("blocks its slot while held and unexpired", () => {
    expect(isHoldActive(aHold(), minutesAfter(NOW, 1))).toBe(true);
  });

  // The point of checking time as well as status: availability must be correct
  // even when the sweep has not run, or did not run at all.
  it("stops blocking the moment it expires, with no sweep involved", () => {
    expect(isHoldActive(aHold(), minutesAfter(NOW, 16))).toBe(false);
  });

  it("stops blocking once it has ended for any reason", () => {
    expect(isHoldActive(aHold({ status: "converted" }), NOW)).toBe(false);
    expect(isHoldActive(aHold({ status: "released" }), NOW)).toBe(false);
    expect(isHoldActive(aHold({ status: "expired" }), NOW)).toBe(false);
  });
});

describe("ending a hold", () => {
  it("converts a held slot once payment is verified", () => {
    const result = convertHold(aHold());
    expect(result.changed).toBe(true);
    expect(result.entity.status).toBe("converted");
  });

  it("expires and releases a held slot", () => {
    expect(expireHold(aHold()).entity.status).toBe("expired");
    expect(releaseHold(aHold()).entity.status).toBe("released");
  });

  it("is a no-op when the hold already ended the same way", () => {
    const converted = aHold({ status: "converted" });
    const result = convertHold(converted);
    expect(result.changed).toBe(false);
    expect(result.entity).toBe(converted);
  });

  it("refuses to reopen or reclassify a hold that already ended", () => {
    expect(() => expireHold(aHold({ status: "converted" }))).toThrow(InvalidTransitionError);
    expect(() => convertHold(aHold({ status: "expired" }))).toThrow(InvalidTransitionError);
    expect(() => releaseHold(aHold({ status: "expired" }))).toThrow(InvalidTransitionError);
  });

  it("never mutates the hold it was given", () => {
    const hold = aHold();
    convertHold(hold);
    expect(hold.status).toBe("held");
  });
});

describe("findBlockingHold and isSlotAvailable", () => {
  const slot = { start: SLOT_START, end: SLOT_END };

  it("reports the hold in the way, so a message can say until when", () => {
    const blocking = aHold();
    expect(findBlockingHold(slot, [blocking], minutesAfter(NOW, 1))).toBe(blocking);
    expect(isSlotAvailable(slot, [blocking], minutesAfter(NOW, 1))).toBe(false);
  });

  it("treats a slot with no holds at all as available", () => {
    expect(isSlotAvailable(slot, [], NOW)).toBe(true);
    expect(findBlockingHold(slot, [], NOW)).toBeUndefined();
  });

  // An abandoned checkout must never take a sellable slot off the calendar.
  it("frees the slot once an abandoned hold expires, even before any sweep", () => {
    expect(isSlotAvailable(slot, [aHold()], minutesAfter(NOW, 16))).toBe(true);
  });

  it("frees the slot when the hold was released or converted", () => {
    expect(isSlotAvailable(slot, [aHold({ status: "released" })], NOW)).toBe(true);
    expect(isSlotAvailable(slot, [aHold({ status: "converted" })], NOW)).toBe(true);
  });

  it("ignores an active hold on a different time", () => {
    const elsewhere = aHold({
      slotStart: new Date("2026-09-11T06:00:00.000Z"),
      slotEnd: new Date("2026-09-11T07:30:00.000Z"),
    });
    expect(isSlotAvailable(slot, [elsewhere], NOW)).toBe(true);
  });

  it("finds the blocking hold among several that do not block", () => {
    const blocking = aHold({ id: "hold_blocking" });
    const holds = [aHold({ id: "hold_released", status: "released" }), blocking];
    expect(findBlockingHold(slot, holds, NOW)?.id).toBe("hold_blocking");
  });
});

describe("sweepExpiredHolds", () => {
  it("returns only the holds it changed", () => {
    const expired = aHold({ id: "hold_expired" });
    const fresh = aHold({ id: "hold_fresh", expiresAt: minutesAfter(NOW, 60) });
    const swept = sweepExpiredHolds([expired, fresh], minutesAfter(NOW, 16));
    expect(swept).toHaveLength(1);
    expect(swept[0]?.id).toBe("hold_expired");
    expect(swept[0]?.status).toBe("expired");
  });

  it("keeps the calendar event id, because the tentative event must be deleted too", () => {
    const swept = sweepExpiredHolds([aHold()], minutesAfter(NOW, 16));
    expect(swept[0]?.calendarEventId).toBe("evt_tentative");
  });

  it("returns nothing when there is nothing to reap", () => {
    expect(sweepExpiredHolds([aHold()], minutesAfter(NOW, 1))).toEqual([]);
  });

  it("leaves holds that already ended alone, however old they are", () => {
    const holds = [
      aHold({ id: "a", status: "converted" }),
      aHold({ id: "b", status: "released" }),
      aHold({ id: "c", status: "expired" }),
    ];
    expect(sweepExpiredHolds(holds, minutesAfter(NOW, 600))).toEqual([]);
  });
});
