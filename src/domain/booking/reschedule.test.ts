import { describe, expect, it } from "vitest";
import { addDays, addMinutes } from "@/lib/time";
import { decideReschedule, type RescheduleInput } from "./reschedule";

/** Thursday 10 September 2026, 19:00 in Dubai. */
const START = new Date("2026-09-10T15:00:00.000Z");
const END = addMinutes(START, 90);
/** Four days before the session. */
const NOW = addDays(START, -4);
const NEW_START = addDays(START, 7);

const MOVABLE: RescheduleInput = {
  status: "confirmed",
  scheduledStart: START,
  scheduledEnd: END,
  rescheduleCount: 0,
  newSlot: { start: NEW_START, end: addMinutes(NEW_START, 90) },
  now: NOW,
};

describe("decideReschedule", () => {
  it("allows one move of a confirmed session, asked for in good time, to a time within the window", () => {
    expect(decideReschedule(MOVABLE)).toEqual({ ok: true });
  });

  it("refuses a second move: each booking can be moved once", () => {
    expect(decideReschedule({ ...MOVABLE, rescheduleCount: 1 })).toEqual({
      ok: false,
      reason: "already_moved",
    });
  });

  it("refuses inside the 24 hours before the session, and allows exactly at 24 hours", () => {
    expect(decideReschedule({ ...MOVABLE, now: addMinutes(START, -24 * 60 + 1) })).toEqual({
      ok: false,
      reason: "too_late",
    });
    expect(decideReschedule({ ...MOVABLE, now: addMinutes(START, -24 * 60) })).toEqual({
      ok: true,
    });
  });

  it("refuses a time more than 90 days after the original, and allows exactly 90", () => {
    const day90 = addDays(START, 90);
    expect(
      decideReschedule({ ...MOVABLE, newSlot: { start: day90, end: addMinutes(day90, 90) } }),
    ).toEqual({ ok: true });
    const day91 = addDays(START, 91);
    expect(
      decideReschedule({ ...MOVABLE, newSlot: { start: day91, end: addMinutes(day91, 90) } }),
    ).toEqual({ ok: false, reason: "outside_window" });
  });

  it("refuses anything but a confirmed session with a time", () => {
    for (const status of [
      "awaiting_schedule",
      "scheduled",
      "completed",
      "cancelled",
      "no_show",
    ] as const) {
      expect(decideReschedule({ ...MOVABLE, status })).toEqual({
        ok: false,
        reason: "not_movable",
      });
    }
    expect(decideReschedule({ ...MOVABLE, scheduledStart: null, scheduledEnd: null })).toEqual({
      ok: false,
      reason: "not_movable",
    });
  });

  it("refuses the time it already has", () => {
    expect(decideReschedule({ ...MOVABLE, newSlot: { start: START, end: END } })).toEqual({
      ok: false,
      reason: "same_time",
    });
  });

  it("refuses a new time that is not the same length as the session", () => {
    expect(
      decideReschedule({
        ...MOVABLE,
        newSlot: { start: NEW_START, end: addMinutes(NEW_START, 60) },
      }),
    ).toEqual({ ok: false, reason: "wrong_length" });
  });
});
