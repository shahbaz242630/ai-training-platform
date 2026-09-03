import { describe, expect, it } from "vitest";
import {
  MAX_SEND_ATTEMPTS,
  messagesOnConfirmation,
  messagesOnSettlement,
  nextAttemptAt,
} from "./schedule";

const NOW = new Date("2026-10-01T09:00:00Z");
const hours = (n: number) => n * 60 * 60_000;

describe("messagesOnSettlement", () => {
  it("queues the payment acknowledgement immediately and nothing else", () => {
    expect(messagesOnSettlement(NOW)).toEqual([
      { templateKey: "payment_receipt", scheduledFor: NOW },
    ]);
  });
});

describe("messagesOnConfirmation", () => {
  it("queues the confirmation now, the reminders before, and the follow-up after", () => {
    const start = new Date(NOW.getTime() + hours(72));
    const end = new Date(start.getTime() + 90 * 60_000);

    expect(messagesOnConfirmation({ scheduledStart: start, scheduledEnd: end, now: NOW })).toEqual([
      { templateKey: "booking_confirmation", scheduledFor: NOW },
      { templateKey: "reminder_24h", scheduledFor: new Date(start.getTime() - hours(24)) },
      { templateKey: "reminder_3h", scheduledFor: new Date(start.getTime() - hours(3)) },
      { templateKey: "follow_up", scheduledFor: new Date(end.getTime() + hours(1)) },
    ]);
  });

  it("drops a reminder whose moment has already passed rather than sending it late", () => {
    // Booked twenty hours ahead: the 24-hour reminder would be due in the past.
    const start = new Date(NOW.getTime() + hours(20));
    const end = new Date(start.getTime() + 90 * 60_000);

    const keys = messagesOnConfirmation({ scheduledStart: start, scheduledEnd: end, now: NOW }).map(
      (m) => m.templateKey,
    );

    expect(keys).toEqual(["booking_confirmation", "reminder_3h", "follow_up"]);
  });

  it("keeps only the confirmation and follow-up for a session starting within three hours", () => {
    const start = new Date(NOW.getTime() + hours(2));
    const end = new Date(start.getTime() + 90 * 60_000);

    const keys = messagesOnConfirmation({ scheduledStart: start, scheduledEnd: end, now: NOW }).map(
      (m) => m.templateKey,
    );

    expect(keys).toEqual(["booking_confirmation", "follow_up"]);
  });

  it("schedules in UTC, untouched by any time zone", () => {
    const start = new Date("2026-12-31T20:00:00Z");
    const end = new Date("2026-12-31T21:30:00Z");
    const [, reminder] = messagesOnConfirmation({
      scheduledStart: start,
      scheduledEnd: end,
      now: NOW,
    });
    expect(reminder?.scheduledFor.toISOString()).toBe("2026-12-30T20:00:00.000Z");
  });
});

describe("nextAttemptAt", () => {
  it("doubles from one minute", () => {
    expect(nextAttemptAt(1, NOW)).toEqual(new Date(NOW.getTime() + 1 * 60_000));
    expect(nextAttemptAt(2, NOW)).toEqual(new Date(NOW.getTime() + 2 * 60_000));
    expect(nextAttemptAt(3, NOW)).toEqual(new Date(NOW.getTime() + 4 * 60_000));
    expect(nextAttemptAt(4, NOW)).toEqual(new Date(NOW.getTime() + 8 * 60_000));
  });

  it("stops at the attempt limit, so a broken message is left for a person", () => {
    expect(nextAttemptAt(MAX_SEND_ATTEMPTS, NOW)).toBeNull();
    expect(nextAttemptAt(MAX_SEND_ATTEMPTS + 1, NOW)).toBeNull();
  });
});
