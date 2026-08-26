import { describe, it, expect } from "vitest";
import {
  InvalidTimeZoneError,
  isKnownTimeZone,
  presentSlot,
  presentSlots,
} from "./slot-presentation";
import type { TimeSlot } from "./provider";

/** Saturday 12 September 2026, 10:00-11:30 in Dubai - still Saturday evening in Auckland. */
const DUBAI_MORNING: TimeSlot = {
  start: new Date("2026-09-12T06:00:00.000Z"),
  end: new Date("2026-09-12T07:30:00.000Z"),
};

/** Saturday 12 September 2026, 18:00-19:30 in Dubai - already Sunday in Auckland. */
const DUBAI_EVENING: TimeSlot = {
  start: new Date("2026-09-12T14:00:00.000Z"),
  end: new Date("2026-09-12T15:30:00.000Z"),
};

/** Saturday 12 September 2026, 22:00-23:30 in Dubai - already Sunday in Auckland. */
const DUBAI_LATE: TimeSlot = {
  start: new Date("2026-09-12T18:00:00.000Z"),
  end: new Date("2026-09-12T19:30:00.000Z"),
};

const slot = (startIso: string, minutes = 90): TimeSlot => ({
  start: new Date(startIso),
  end: new Date(new Date(startIso).getTime() + minutes * 60_000),
});

describe("presentSlot", () => {
  it("renders the slot in the customer's own zone", () => {
    expect(presentSlot(DUBAI_EVENING, "Europe/London").localTime).toBe("15:00 - 16:30");
    expect(presentSlot(DUBAI_EVENING, "Asia/Dubai").localTime).toBe("18:00 - 19:30");
  });

  it("uses a 24-hour clock, so am and pm cannot be misread", () => {
    const evening = presentSlot(DUBAI_LATE, "Asia/Dubai").localTime;
    expect(evening).toBe("22:00 - 23:30");
    expect(evening).not.toMatch(/[ap]m/i);
  });

  it("carries the UTC instant for the form to post back, not the string on screen", () => {
    const presented = presentSlot(DUBAI_EVENING, "Europe/London");
    expect(presented.isoStart).toBe("2026-09-12T14:00:00.000Z");
    expect(new Date(presented.isoStart).getTime()).toBe(DUBAI_EVENING.start.getTime());
  });

  it("adds a Gulf Standard Time reference for a customer in another zone", () => {
    expect(presentSlot(DUBAI_EVENING, "Europe/London").gstReference).toBe("18:00 GST");
  });

  // Repeating a customer's own time back at them as "GST" is noise, and noise
  // trains people to stop reading.
  it("omits the reference when the customer's clock already reads the same", () => {
    expect(presentSlot(DUBAI_EVENING, "Asia/Dubai").gstReference).toBeNull();
  });

  it("omits it for a different zone that happens to share the offset", () => {
    // Muscat is UTC+4 with no daylight saving, exactly like Dubai.
    expect(presentSlot(DUBAI_EVENING, "Asia/Muscat").gstReference).toBeNull();
  });

  it("names our date in the reference when it is a different day for us than for them", () => {
    // 22:00 Saturday in Dubai is 06:00 Sunday in Auckland. A bare "22:00 GST"
    // beside a Sunday heading reads as a contradiction.
    const presented = presentSlot(DUBAI_LATE, "Pacific/Auckland");
    expect(presented.localTime).toBe("06:00 - 07:30");
    expect(presented.gstReference).toContain("22:00 GST");
    expect(presented.gstReference).toContain("Sat");
    expect(presented.gstReference).toContain("12");
  });

  it("throws on a zone the runtime does not know, rather than quietly using ours", () => {
    expect(() => presentSlot(DUBAI_EVENING, "Nowhere/Fake")).toThrow(InvalidTimeZoneError);
  });
});

describe("presentSlots", () => {
  it("groups by the customer's calendar day, not ours", () => {
    // Both slots are Saturday in Dubai. In Auckland the 10:00 one is Saturday
    // evening and the 18:00 one is already Sunday morning, so a customer there
    // must see two days - grouping by our calendar would file the second under
    // a date they never see.
    const days = presentSlots([DUBAI_MORNING, DUBAI_EVENING], "Pacific/Auckland");
    expect(days).toHaveLength(2);
    expect(days[0]?.isoDate).toBe("2026-09-12");
    expect(days[1]?.isoDate).toBe("2026-09-13");

    // The same two slots are one day for a customer in Dubai.
    expect(presentSlots([DUBAI_MORNING, DUBAI_EVENING], "Asia/Dubai")).toHaveLength(1);
  });

  it("keeps them on one day for a customer whose calendar agrees with ours", () => {
    const days = presentSlots([DUBAI_EVENING, DUBAI_LATE], "Asia/Dubai");
    expect(days).toHaveLength(1);
    expect(days[0]?.slots).toHaveLength(2);
  });

  it("returns days in order, and slots within a day in order", () => {
    const days = presentSlots(
      [slot("2026-09-14T15:00:00.000Z"), slot("2026-09-12T14:00:00.000Z"), DUBAI_LATE],
      "Asia/Dubai",
    );
    expect(days.map((day) => day.isoDate)).toEqual(["2026-09-12", "2026-09-14"]);
    expect(days[0]?.slots.map((s) => s.localTime)).toEqual(["18:00 - 19:30", "22:00 - 23:30"]);
  });

  it("sorts input it was given out of order", () => {
    const days = presentSlots([DUBAI_LATE, DUBAI_EVENING], "Asia/Dubai");
    expect(days[0]?.slots[0]?.localTime).toBe("18:00 - 19:30");
  });

  it("labels each day readably, including the year", () => {
    const days = presentSlots([DUBAI_EVENING], "Asia/Dubai");
    expect(days[0]?.label).toContain("Saturday");
    expect(days[0]?.label).toContain("September");
    // A 60-day horizon can cross a new year, so the year is never left implied.
    expect(days[0]?.label).toContain("2026");
  });

  it("labels the day in the customer's zone, matching how it was grouped", () => {
    const days = presentSlots([DUBAI_LATE], "Pacific/Auckland");
    expect(days[0]?.isoDate).toBe("2026-09-13");
    expect(days[0]?.label).toContain("Sunday");
    expect(days[0]?.label).toContain("13");
  });

  it("returns nothing for nothing", () => {
    expect(presentSlots([], "Asia/Dubai")).toEqual([]);
  });

  it("throws on an unknown zone", () => {
    expect(() => presentSlots([DUBAI_EVENING], "Mars/Olympus_Mons")).toThrow(InvalidTimeZoneError);
  });

  /*
    The customer's zone may observe daylight saving even though ours never
    does. The same Dubai hour is a different London hour in July and December,
    and the GST reference has to move with it - this is the bug that shows up
    twice a year, in the weeks nobody is testing.
  */
  it("follows the customer's daylight saving even though ours has none", () => {
    const july = slot("2026-07-11T14:00:00.000Z"); // 18:00 Dubai
    const december = slot("2026-12-12T14:00:00.000Z"); // 18:00 Dubai

    expect(presentSlot(july, "Europe/London").localTime).toBe("15:00 - 16:30"); // BST
    expect(presentSlot(december, "Europe/London").localTime).toBe("14:00 - 15:30"); // GMT

    expect(presentSlot(july, "Europe/London").gstReference).toBe("18:00 GST");
    expect(presentSlot(december, "Europe/London").gstReference).toBe("18:00 GST");
    expect(presentSlot(july, "Asia/Dubai").localTime).toBe(
      presentSlot(december, "Asia/Dubai").localTime,
    );
  });
});

describe("isKnownTimeZone", () => {
  it("accepts real zones and refuses invented ones", () => {
    expect(isKnownTimeZone("Asia/Dubai")).toBe(true);
    expect(isKnownTimeZone("UTC")).toBe(true);
    expect(isKnownTimeZone("Nowhere/Fake")).toBe(false);
    expect(isKnownTimeZone("")).toBe(false);
  });
});
