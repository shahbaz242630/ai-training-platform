import { describe, it, expect } from "vitest";
import { DAYS_PER_PAGE, resolveBookingWeek } from "./booking-week";
import { gstIsoDate } from "@/lib/time";

/** Wednesday 26 August 2026, 20:00 in Dubai. */
const NOW = new Date("2026-08-26T16:00:00.000Z");
const HORIZON = 60;

const week = (requested?: string) => resolveBookingWeek(requested, NOW, HORIZON);

describe("resolveBookingWeek", () => {
  it("starts on today when nothing is asked for", () => {
    const current = week();
    expect(current.isoDate).toBe("2026-08-26");
    expect(current.isCurrent).toBe(true);
  });

  it("shows a week at a time", () => {
    const current = week();
    const days = (current.endUtc.getTime() - current.startUtc.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBe(DAYS_PER_PAGE);
  });

  it("moves forward a week at a time", () => {
    expect(week().nextIsoDate).toBe("2026-09-02");
    expect(week("2026-09-02").isoDate).toBe("2026-09-02");
    expect(week("2026-09-02").nextIsoDate).toBe("2026-09-09");
  });

  it("offers no way back from today, so nobody is sent to a week they cannot book", () => {
    expect(week().previousIsoDate).toBeNull();
  });

  it("offers a way back from a later week", () => {
    expect(week("2026-09-09").previousIsoDate).toBe("2026-09-02");
  });

  it("lands exactly on today when stepping back would overshoot it", () => {
    // Four days forward, so one step back is three days before today.
    const stepBack = week("2026-08-30").previousIsoDate;
    expect(stepBack).toBe("2026-08-26");
  });

  /*
    The week arrives in a query string anybody can edit. None of the following
    may produce a page showing times that cannot be booked.
  */
  it("ignores a week in the past", () => {
    expect(week("2020-01-01").isoDate).toBe("2026-08-26");
    expect(week("2026-08-25").isoDate).toBe("2026-08-26");
  });

  it("clamps a week beyond the booking horizon", () => {
    const far = week("2030-01-01");
    expect(far.isoDate).toBe(gstIsoDate(new Date(NOW.getTime() + HORIZON * 24 * 60 * 60 * 1000)));
    expect(far.nextIsoDate).toBeNull();
  });

  it("stops offering a next week once the horizon is inside it", () => {
    const last = week(gstIsoDate(new Date(NOW.getTime() + HORIZON * 24 * 60 * 60 * 1000)));
    expect(last.nextIsoDate).toBeNull();
  });

  it("falls back to today for anything that is not a date", () => {
    for (const nonsense of ["", "not-a-date", "26-08-2026", "2026/08/26", "../../etc/passwd"]) {
      expect(week(nonsense).isoDate).toBe("2026-08-26");
    }
  });

  it("falls back to today for a date that does not exist", () => {
    expect(week("2026-02-31").isoDate).toBe("2026-08-26");
    expect(week("2026-13-01").isoDate).toBe("2026-08-26");
  });

  /*
    The Dubai day starts at 20:00 UTC the previous day. Late-evening UTC is
    already tomorrow in Dubai, and the week must follow the customer-facing
    calendar rather than UTC's.
  */
  it("uses the Dubai day, not the UTC one", () => {
    const lateUtc = new Date("2026-08-26T21:00:00.000Z"); // already 01:00 on the 27th in Dubai
    expect(resolveBookingWeek(undefined, lateUtc, HORIZON).isoDate).toBe("2026-08-27");
  });

  it("gives a start instant that is genuinely Dubai midnight", () => {
    // Midnight in Dubai is 20:00 UTC the previous day.
    expect(week().startUtc).toEqual(new Date("2026-08-25T20:00:00.000Z"));
  });
});
