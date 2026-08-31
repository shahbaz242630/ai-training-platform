import { describe, it, expect } from "vitest";
import { holdInterval, isOfferedSlot, reserveSlotRequestSchema } from "./reserve-slot";

/**
 * The rule that stops a browser choosing its own booking time.
 *
 * Everything here defends one thing: the instant a request asks for must be
 * one WE published, not merely one that happens to be free. Nothing is booked
 * at 03:00 on a Sunday, so a conflict check alone would wave it straight
 * through.
 */

const offered = [
  { start: new Date("2027-05-10T14:00:00Z") },
  { start: new Date("2027-05-10T14:30:00Z") },
  { start: new Date("2027-05-11T06:00:00Z") },
];

describe("isOfferedSlot", () => {
  it("accepts an instant we published", () => {
    expect(isOfferedSlot(new Date("2027-05-10T14:30:00Z"), offered)).toBe(true);
  });

  /*
    The attack this exists for. 03:00 clashes with nothing, so anything that
    only checked for conflicts would allow it.
  */
  it("refuses an instant nobody was ever offered", () => {
    expect(isOfferedSlot(new Date("2027-05-11T03:00:00Z"), offered)).toBe(false);
  });

  /*
    Not "inside an offered slot" - exactly one. A start ten minutes into a
    published slot would drift the session off the grid that every buffer and
    conflict calculation assumes.
  */
  it("refuses a time that merely falls inside an offered slot", () => {
    expect(isOfferedSlot(new Date("2027-05-10T14:10:00Z"), offered)).toBe(false);
  });

  it("refuses everything when nothing is on offer", () => {
    expect(isOfferedSlot(new Date("2027-05-10T14:00:00Z"), [])).toBe(false);
  });

  // Compared as instants, so the same moment written in another zone matches.
  it("matches on the instant rather than on how it was written", () => {
    expect(isOfferedSlot(new Date("2027-05-10T18:00:00+04:00"), offered)).toBe(true);
  });
});

describe("holdInterval", () => {
  it("covers exactly the session and no more", () => {
    const interval = holdInterval(new Date("2027-05-10T14:00:00Z"), 90);
    expect(interval.start.toISOString()).toBe("2027-05-10T14:00:00.000Z");
    expect(interval.end.toISOString()).toBe("2027-05-10T15:30:00.000Z");
  });

  /*
    Buffers are applied when slots are GENERATED, deliberately, and must not be
    smuggled into the hold as well - doing it twice would silently block twice
    the quiet time either side of every session.
  */
  it("adds no buffer of its own", () => {
    const interval = holdInterval(new Date("2027-05-10T14:00:00Z"), 60);
    expect(interval.end.getTime() - interval.start.getTime()).toBe(60 * 60_000);
  });
});

describe("reserveSlotRequestSchema", () => {
  const valid = { slug: "ai-foundations", slotStart: "2027-05-10T14:00:00.000Z" };

  it("accepts a well formed request", () => {
    expect(reserveSlotRequestSchema.safeParse(valid).success).toBe(true);
  });

  /*
    Strict rather than stripping. A handler that silently drops unknown keys is
    how an extra field rides along into whatever the next change spreads into a
    record.
  */
  it("refuses a request carrying a field it was never offered", () => {
    const result = reserveSlotRequestSchema.safeParse({ ...valid, priceFils: 1 });
    expect(result.success).toBe(false);
  });

  it("refuses a slot start that is not a real instant", () => {
    expect(
      reserveSlotRequestSchema.safeParse({ ...valid, slotStart: "next Tuesday" }).success,
    ).toBe(false);
    expect(reserveSlotRequestSchema.safeParse({ ...valid, slotStart: "" }).success).toBe(false);
  });

  it("refuses a missing or empty slug", () => {
    expect(reserveSlotRequestSchema.safeParse({ slotStart: valid.slotStart }).success).toBe(false);
    expect(reserveSlotRequestSchema.safeParse({ ...valid, slug: "" }).success).toBe(false);
  });

  it("refuses something that is not an object at all", () => {
    expect(reserveSlotRequestSchema.safeParse("ai-foundations").success).toBe(false);
    expect(reserveSlotRequestSchema.safeParse(null).success).toBe(false);
  });
});
