import { describe, it, expect } from "vitest";
import type { AvailabilityRules } from "@/config/availability";
import { addDays, addMinutes, at, toGstParts, type Weekday } from "@/lib/time";
import { MockSchedulingProvider } from "./mock-provider";
import { EventNotFoundError, SlotUnavailableError, type ExternalEvent } from "./provider";

/*
  Tests use their own rules rather than the shipped configuration. The real
  hours are a business decision that will change; a test that fails when the
  founder picks his actual working hours is a test nobody trusts.
*/
const MONDAY: Weekday = 1;
const SATURDAY: Weekday = 6;

const TEST_RULES: AvailabilityRules = {
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
const SESSION_MINUTES = 90;

/** Saturday 12 September, 10:00 in Dubai - the first bookable slot under these rules. */
const FIRST_SATURDAY_SLOT = {
  start: new Date("2026-09-12T06:00:00.000Z"),
  end: new Date("2026-09-12T07:30:00.000Z"),
};

const provider = (seedEvents: readonly ExternalEvent[] = [], now: Date = NOW) =>
  new MockSchedulingProvider({ now: () => now, rules: TEST_RULES, seedEvents });

const query = (days = 10, from: Date = NOW) => ({
  from,
  to: addDays(from, days),
  durationMinutes: SESSION_MINUTES,
});

const seedEvent = (overrides: Partial<ExternalEvent> = {}): ExternalEvent => ({
  externalId: "seed_1",
  status: "confirmed",
  start: FIRST_SATURDAY_SLOT.start,
  end: FIRST_SATURDAY_SLOT.end,
  meetingUrl: null,
  ...overrides,
});

describe("listAvailability", () => {
  it("offers only slots inside the configured windows, read in Dubai time", async () => {
    const slots = await provider().listAvailability(query());
    expect(slots.length).toBeGreaterThan(0);
    for (const slot of slots) {
      const parts = toGstParts(slot.start);
      expect([MONDAY, SATURDAY]).toContain(parts.weekday);
      if (parts.weekday === SATURDAY) {
        expect(parts.minutesOfDay).toBeGreaterThanOrEqual(at(10));
        expect(parts.minutesOfDay + SESSION_MINUTES).toBeLessThanOrEqual(at(13));
      } else {
        expect(parts.minutesOfDay).toBeGreaterThanOrEqual(at(18));
        expect(parts.minutesOfDay + SESSION_MINUTES).toBeLessThanOrEqual(at(21));
      }
    }
  });

  it("fits as many whole sessions into a window as the interval allows, and no more", async () => {
    const slots = await provider().listAvailability(query());
    const saturday = slots.filter((slot) => toGstParts(slot.start).weekday === SATURDAY);
    // A three-hour window at 30-minute intervals holds four 90-minute starts:
    // 10:00, 10:30, 11:00 and 11:30. An 11:45 start would run past the window.
    expect(saturday.map((slot) => toGstParts(slot.start).minutesOfDay)).toEqual([
      at(10),
      at(10, 30),
      at(11),
      at(11, 30),
    ]);
  });

  it("hides slots inside the notice period, even when the window is open", async () => {
    // Monday 7 September 18:00 Dubai is a valid window but only 8 hours away.
    const slots = await provider().listAvailability(query());
    expect(slots.every((slot) => slot.start.getTime() >= addMinutes(NOW, 24 * 60).getTime())).toBe(
      true,
    );
    expect(slots.some((slot) => slot.start < new Date("2026-09-08T00:00:00.000Z"))).toBe(false);
  });

  it("hides slots beyond the booking horizon", async () => {
    const slots = await provider().listAvailability(query(365));
    const horizon = addDays(NOW, TEST_RULES.bookingHorizonDays);
    expect(slots.every((slot) => slot.start.getTime() <= horizon.getTime())).toBe(true);
  });

  it("offers nothing for a session longer than any window", async () => {
    const slots = await provider().listAvailability({ ...query(), durationMinutes: 300 });
    expect(slots).toEqual([]);
  });

  it("offers nothing for a session of no length", async () => {
    expect(await provider().listAvailability({ ...query(), durationMinutes: 0 })).toEqual([]);
    expect(await provider().listAvailability({ ...query(), durationMinutes: -30 })).toEqual([]);
  });

  it("offers nothing when the search window closes before the notice period ends", async () => {
    expect(await provider().listAvailability(query(1))).toEqual([]);
  });

  it("does not offer a slot already taken on the calendar", async () => {
    const slots = await provider([seedEvent()]).listAvailability(query());
    expect(slots.some((slot) => slot.start.getTime() === FIRST_SATURDAY_SLOT.start.getTime())).toBe(
      false,
    );
  });

  it("keeps the buffer clear either side of a booked session", async () => {
    const booked = seedEvent({
      start: new Date("2026-09-12T07:30:00.000Z"), // 11:30 Dubai
      end: new Date("2026-09-12T09:00:00.000Z"), // 13:00 Dubai
    });
    const saturdayStarts = async (rules: AvailabilityRules) => {
      const scheduler = new MockSchedulingProvider({
        now: () => NOW,
        rules,
        seedEvents: [booked],
      });
      const slots = await scheduler.listAvailability(query());
      return slots
        .filter((slot) => toGstParts(slot.start).weekday === SATURDAY)
        .map((slot) => toGstParts(slot.start).minutesOfDay);
    };

    // With no buffer, a 10:00-11:30 session is adjacent to the booking and
    // therefore offered. With 15 minutes either side it is not - which is the
    // whole difference a buffer makes, and the reason it is configurable.
    expect(await saturdayStarts({ ...TEST_RULES, bufferMinutes: 0 })).toEqual([at(10)]);
    expect(await saturdayStarts(TEST_RULES)).toEqual([]);
  });

  it("ignores a cancelled event when working out what is free", async () => {
    const slots = await provider([seedEvent({ status: "cancelled" })]).listAvailability(query());
    expect(slots.some((slot) => slot.start.getTime() === FIRST_SATURDAY_SLOT.start.getTime())).toBe(
      true,
    );
  });
});

describe("holdSlot", () => {
  const holdInput = {
    slot: FIRST_SATURDAY_SLOT,
    subject: "Claude, Claude Code & Advanced Workflows",
    attendeeName: "A Customer",
    attendeeEmail: "customer@example.com",
  };

  it("blocks the slot with a tentative event carrying no meeting link", async () => {
    const event = await provider().holdSlot(holdInput);
    expect(event.status).toBe("tentative");
    // A join link before payment would tell someone they have a session they
    // have not paid for.
    expect(event.meetingUrl).toBeNull();
    expect(event.start).toEqual(FIRST_SATURDAY_SLOT.start);
  });

  it("makes the slot unavailable to everyone else immediately", async () => {
    const scheduler = provider();
    await scheduler.holdSlot(holdInput);
    const slots = await scheduler.listAvailability(query());
    expect(slots.some((slot) => slot.start.getTime() === FIRST_SATURDAY_SLOT.start.getTime())).toBe(
      false,
    );
  });

  it("refuses the second of two attempts on the same slot", async () => {
    const scheduler = provider();
    await scheduler.holdSlot(holdInput);
    await expect(scheduler.holdSlot(holdInput)).rejects.toBeInstanceOf(SlotUnavailableError);
  });

  // Everything below is a request the browser could make but the provider
  // never offered. Re-validating here is what stops a crafted request booking
  // a time nobody is available for.
  it("refuses a slot outside working hours", async () => {
    const slot = {
      start: new Date("2026-09-12T00:00:00.000Z"), // 04:00 Dubai
      end: new Date("2026-09-12T01:30:00.000Z"),
    };
    await expect(provider().holdSlot({ ...holdInput, slot })).rejects.toBeInstanceOf(
      SlotUnavailableError,
    );
  });

  it("refuses a slot on a day with no window at all", async () => {
    const slot = {
      start: new Date("2026-09-13T06:00:00.000Z"), // Sunday 10:00 Dubai
      end: new Date("2026-09-13T07:30:00.000Z"),
    };
    await expect(provider().holdSlot({ ...holdInput, slot })).rejects.toBeInstanceOf(
      SlotUnavailableError,
    );
  });

  it("refuses a slot that starts off the interval grid", async () => {
    const slot = {
      start: new Date("2026-09-12T06:10:00.000Z"), // 10:10 Dubai
      end: new Date("2026-09-12T07:40:00.000Z"),
    };
    await expect(provider().holdSlot({ ...holdInput, slot })).rejects.toBeInstanceOf(
      SlotUnavailableError,
    );
  });

  it("refuses a slot that would overrun the end of its window", async () => {
    const slot = {
      start: new Date("2026-09-12T08:30:00.000Z"), // 12:30 Dubai, window ends 13:00
      end: new Date("2026-09-12T10:00:00.000Z"),
    };
    await expect(provider().holdSlot({ ...holdInput, slot })).rejects.toBeInstanceOf(
      SlotUnavailableError,
    );
  });

  it("refuses a slot inside the notice period", async () => {
    const slot = {
      start: new Date("2026-09-07T14:00:00.000Z"), // Monday 18:00 Dubai, 8 hours away
      end: new Date("2026-09-07T15:30:00.000Z"),
    };
    await expect(provider().holdSlot({ ...holdInput, slot })).rejects.toBeInstanceOf(
      SlotUnavailableError,
    );
  });

  it("refuses a slot beyond the booking horizon", async () => {
    const slot = {
      start: new Date("2026-12-12T06:00:00.000Z"), // a Saturday, but months out
      end: new Date("2026-12-12T07:30:00.000Z"),
    };
    await expect(provider().holdSlot({ ...holdInput, slot })).rejects.toBeInstanceOf(
      SlotUnavailableError,
    );
  });

  it("refuses a slot of no length", async () => {
    const slot = { start: FIRST_SATURDAY_SLOT.start, end: FIRST_SATURDAY_SLOT.start };
    await expect(provider().holdSlot({ ...holdInput, slot })).rejects.toBeInstanceOf(
      SlotUnavailableError,
    );
  });

  it("names the slot in the error, so a caller can offer another one", async () => {
    const scheduler = provider();
    await scheduler.holdSlot(holdInput);
    await expect(scheduler.holdSlot(holdInput)).rejects.toThrow(
      FIRST_SATURDAY_SLOT.start.toISOString(),
    );
  });

  it("issues deterministic ids, so a test reads the same on every run", async () => {
    const scheduler = new MockSchedulingProvider({
      now: () => NOW,
      rules: TEST_RULES,
      idPrefix: "evt",
    });
    const first = await scheduler.holdSlot(holdInput);
    const second = await scheduler.holdSlot({
      ...holdInput,
      slot: {
        start: new Date("2026-09-14T14:00:00.000Z"), // Monday 18:00 Dubai
        end: new Date("2026-09-14T15:30:00.000Z"),
      },
    });
    expect(first.externalId).toBe("evt_1");
    expect(second.externalId).toBe("evt_2");
  });
});

describe("confirmSlot", () => {
  const holdInput = {
    slot: FIRST_SATURDAY_SLOT,
    subject: "A session",
    attendeeName: "A Customer",
    attendeeEmail: "customer@example.com",
  };

  it("promotes the tentative event and issues the meeting link", async () => {
    const scheduler = provider();
    const held = await scheduler.holdSlot(holdInput);
    const confirmed = await scheduler.confirmSlot(held.externalId);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.meetingUrl).toContain(held.externalId);
    expect(confirmed.start).toEqual(held.start);
  });

  it("is a no-op the second time, because the webhook that triggers it retries", async () => {
    const scheduler = provider();
    const held = await scheduler.holdSlot(holdInput);
    const first = await scheduler.confirmSlot(held.externalId);
    const second = await scheduler.confirmSlot(held.externalId);
    expect(second).toEqual(first);
  });

  it("refuses an event that is not there", async () => {
    await expect(provider().confirmSlot("nope")).rejects.toBeInstanceOf(EventNotFoundError);
  });

  it("refuses to confirm a cancelled event", async () => {
    const scheduler = provider();
    const held = await scheduler.holdSlot(holdInput);
    await scheduler.cancelEvent(held.externalId);
    await expect(scheduler.confirmSlot(held.externalId)).rejects.toBeInstanceOf(
      SlotUnavailableError,
    );
  });
});

describe("releaseSlot and cancelEvent", () => {
  const holdInput = {
    slot: FIRST_SATURDAY_SLOT,
    subject: "A session",
    attendeeName: "A Customer",
    attendeeEmail: "customer@example.com",
  };

  it("gives the slot back when a hold is released", async () => {
    const scheduler = provider();
    const held = await scheduler.holdSlot(holdInput);
    await scheduler.releaseSlot(held.externalId);
    const slots = await scheduler.listAvailability(query());
    expect(slots.some((slot) => slot.start.getTime() === FIRST_SATURDAY_SLOT.start.getTime())).toBe(
      true,
    );
    expect(await scheduler.getEvent(held.externalId)).toBeNull();
  });

  // The sweep that reaps expired holds retries. Cleanup that throws on an
  // already-clean state blocks everything queued behind it.
  it("says nothing when releasing something already gone", async () => {
    await expect(provider().releaseSlot("never_existed")).resolves.toBeUndefined();
  });

  it("frees the slot and drops the meeting link when a session is cancelled", async () => {
    const scheduler = provider();
    const held = await scheduler.holdSlot(holdInput);
    await scheduler.confirmSlot(held.externalId);
    await scheduler.cancelEvent(held.externalId);

    const event = await scheduler.getEvent(held.externalId);
    expect(event?.status).toBe("cancelled");
    expect(event?.meetingUrl).toBeNull();

    const slots = await scheduler.listAvailability(query());
    expect(slots.some((slot) => slot.start.getTime() === FIRST_SATURDAY_SLOT.start.getTime())).toBe(
      true,
    );
  });

  // Unlike releasing, this one must not be silent: a confirmed session that has
  // vanished means a customer is expecting something nobody knows about.
  it("refuses to cancel an event that is not there", async () => {
    await expect(provider().cancelEvent("never_existed")).rejects.toBeInstanceOf(
      EventNotFoundError,
    );
  });
});

describe("getEvent and listEvents", () => {
  it("reads an event back for reconciliation, and null when there is none", async () => {
    const scheduler = provider([seedEvent()]);
    expect((await scheduler.getEvent("seed_1"))?.externalId).toBe("seed_1");
    expect(await scheduler.getEvent("absent")).toBeNull();
  });

  it("lists everything it is holding", async () => {
    const scheduler = provider([seedEvent()]);
    expect(scheduler.listEvents()).toHaveLength(1);
  });

  it("defaults to the real clock and the shipped rules when told nothing", async () => {
    const scheduler = new MockSchedulingProvider();
    expect(scheduler.listEvents()).toEqual([]);
    // Only that it runs and returns a well-formed answer - the shipped hours
    // are placeholders and must not be asserted on here.
    const slots = await scheduler.listAvailability({
      from: new Date(),
      to: addDays(new Date(), 14),
      durationMinutes: SESSION_MINUTES,
    });
    expect(Array.isArray(slots)).toBe(true);
  });
});
