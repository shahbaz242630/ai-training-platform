import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AvailabilityRules } from "@/config/availability";
import { MockSchedulingProvider } from "@/domain/scheduling/mock-provider";
import type { SchedulingProvider } from "@/domain/scheduling/provider";
import { at, type Weekday } from "@/lib/time";
import { resetLogSink, setLogSink, type LogRecord } from "@/lib/logger";
import { blockCalendar } from "./calendar-hold";

const SATURDAY: Weekday = 6;
const RULES: AvailabilityRules = {
  windows: [{ weekday: SATURDAY, startMinutes: at(10), endMinutes: at(13) }],
  slotIntervalMinutes: 30,
  bufferMinutes: 15,
  minimumNoticeHours: 24,
  bookingHorizonDays: 30,
};
const NOW = new Date("2026-09-07T06:00:00.000Z");
const SLOT = {
  start: new Date("2026-09-12T06:00:00.000Z"),
  end: new Date("2026-09-12T07:30:00.000Z"),
};

const input = (provider: SchedulingProvider) => ({
  provider,
  holdId: "hold_1",
  slot: SLOT,
  subject: "A session",
  attendeeName: "Amina Khan",
  attendeeEmail: "amina@example.com",
});

let logs: LogRecord[];
beforeEach(() => {
  logs = [];
  setLogSink((r) => {
    logs.push(r);
  });
});
afterEach(() => resetLogSink());

describe("blockCalendar", () => {
  it("blocks the slot and returns the event id to attach, passing the hold id as the reference", async () => {
    const provider = new MockSchedulingProvider({ now: () => NOW, rules: RULES });

    const outcome = await blockCalendar(input(provider));

    expect(outcome).toEqual({ kind: "blocked", calendarEventId: "mock_evt_1" });
    expect(provider.listEvents()).toHaveLength(1);
    expect(logs).toEqual([]);
  });

  it("reports the time as unavailable when the calendar refuses it, and treats that as normal", async () => {
    const provider = new MockSchedulingProvider({
      now: () => NOW,
      rules: RULES,
      seedEvents: [
        {
          externalId: "busy",
          status: "confirmed",
          start: SLOT.start,
          end: SLOT.end,
          meetingUrl: null,
        },
      ],
    });

    const outcome = await blockCalendar(input(provider));

    expect(outcome).toEqual({ kind: "unavailable" });
    expect(logs.filter((l) => l.level === "error")).toEqual([]);
  });

  it("reports the calendar as unreachable, loudly, and lets checkout carry on", async () => {
    const down: SchedulingProvider = {
      listAvailability: () => Promise.reject(new Error("no")),
      holdSlot: () => Promise.reject(new Error("ECONNRESET")),
      confirmSlot: () => Promise.reject(new Error("no")),
      releaseSlot: () => Promise.reject(new Error("no")),
      cancelEvent: () => Promise.reject(new Error("no")),
      getEvent: () => Promise.reject(new Error("no")),
    };

    const outcome = await blockCalendar(input(down));

    expect(outcome).toEqual({ kind: "unblocked", reason: "ECONNRESET" });
    expect(
      logs.some((l) => l.level === "error" && l.message.includes("could not be blocked")),
    ).toBe(true);
  });
});
