import { describe, it, expect } from "vitest";
import {
  BookingShapeError,
  UnpaidConfirmationError,
  cancelBooking,
  completeBooking,
  confirmBooking,
  createBooking,
  markBookingNoShow,
  releaseBookingSlot,
  scheduleBooking,
  type Booking,
} from "./booking";
import { InvalidTransitionError } from "./transitions";

const NOW = new Date("2026-09-01T10:00:00.000Z");
const LATER = new Date("2026-09-01T10:05:00.000Z");
const SLOT_START = new Date("2026-09-10T06:00:00.000Z"); // 10:00 in Dubai
const SLOT_END = new Date("2026-09-10T07:30:00.000Z"); // a 90-minute session

const baseInput = {
  id: "bkg_1",
  orderId: "ord_1",
  sessionSlug: "claude-claude-code",
  sequence: 1,
  customerTimezone: "Asia/Dubai",
  now: NOW,
};

const aBooking = (overrides: Partial<Booking> = {}): Booking => ({
  ...createBooking(baseInput),
  ...overrides,
});

const aScheduledBooking = (overrides: Partial<Booking> = {}): Booking =>
  aBooking({
    status: "scheduled",
    scheduledStart: SLOT_START,
    scheduledEnd: SLOT_END,
    calendarEventId: "evt_1",
    ...overrides,
  });

describe("createBooking", () => {
  it("starts awaiting a slot, with no times set", () => {
    const booking = createBooking(baseInput);
    expect(booking.status).toBe("awaiting_schedule");
    expect(booking.scheduledStart).toBeNull();
    expect(booking.scheduledEnd).toBeNull();
    expect(booking.meetingUrl).toBeNull();
    expect(booking.meetingProvider).toBe("microsoft_teams");
  });

  it("accepts the second session of a pathway", () => {
    expect(createBooking({ ...baseInput, sequence: 2 }).sequence).toBe(2);
  });

  it("refuses a sequence outside a single session or a pair", () => {
    expect(() => createBooking({ ...baseInput, sequence: 3 })).toThrow(BookingShapeError);
    expect(() => createBooking({ ...baseInput, sequence: 0 })).toThrow(BookingShapeError);
  });

  it("refuses a missing timezone, because a confirmation would show the wrong time", () => {
    expect(() => createBooking({ ...baseInput, customerTimezone: "   " })).toThrow(
      BookingShapeError,
    );
  });
});

describe("scheduleBooking", () => {
  it("attaches the slot and the calendar event together with the status", () => {
    const result = scheduleBooking(
      aBooking(),
      { start: SLOT_START, end: SLOT_END, calendarEventId: "evt_1" },
      LATER,
    );
    expect(result.changed).toBe(true);
    expect(result.entity.status).toBe("scheduled");
    expect(result.entity.scheduledStart).toEqual(SLOT_START);
    expect(result.entity.scheduledEnd).toEqual(SLOT_END);
    expect(result.entity.calendarEventId).toBe("evt_1");
    expect(result.entity.updatedAt).toEqual(LATER);
  });

  it("keeps an existing calendar event when the caller supplies none", () => {
    const booking = aBooking({ calendarEventId: "evt_existing", schedulerExternalId: "sch_1" });
    const result = scheduleBooking(booking, { start: SLOT_START, end: SLOT_END }, LATER);
    expect(result.entity.calendarEventId).toBe("evt_existing");
    expect(result.entity.schedulerExternalId).toBe("sch_1");
  });

  it("refuses a slot that ends before it starts", () => {
    expect(() => scheduleBooking(aBooking(), { start: SLOT_END, end: SLOT_START }, LATER)).toThrow(
      BookingShapeError,
    );
  });

  it("refuses a zero-length slot", () => {
    expect(() =>
      scheduleBooking(aBooking(), { start: SLOT_START, end: SLOT_START }, LATER),
    ).toThrow(BookingShapeError);
  });

  it("refuses to schedule a cancelled booking", () => {
    expect(() =>
      scheduleBooking(
        aBooking({ status: "cancelled" }),
        { start: SLOT_START, end: SLOT_END },
        LATER,
      ),
    ).toThrow(InvalidTransitionError);
  });

  it("allows rescheduling a booking that lost its slot", () => {
    const recovered = scheduleBooking(
      aBooking({ status: "awaiting_schedule" }),
      { start: SLOT_START, end: SLOT_END },
      LATER,
    );
    expect(recovered.entity.status).toBe("scheduled");
  });
});

describe("confirmBooking", () => {
  it("confirms a scheduled booking once its order is paid", () => {
    const result = confirmBooking(
      aScheduledBooking(),
      { orderPaymentStatus: "paid", meetingUrl: "https://teams.microsoft.com/l/meetup-join/x" },
      LATER,
    );
    expect(result.changed).toBe(true);
    expect(result.entity.status).toBe("confirmed");
    expect(result.entity.meetingUrl).toBe("https://teams.microsoft.com/l/meetup-join/x");
  });

  // The single most expensive mistake available to this codebase.
  it("refuses to confirm while payment is still pending", () => {
    expect(() =>
      confirmBooking(aScheduledBooking(), { orderPaymentStatus: "pending" }, LATER),
    ).toThrow(UnpaidConfirmationError);
  });

  it("refuses to confirm when payment failed", () => {
    expect(() =>
      confirmBooking(aScheduledBooking(), { orderPaymentStatus: "failed" }, LATER),
    ).toThrow(UnpaidConfirmationError);
  });

  it("refuses to confirm a refunded order - money returned is not money held", () => {
    expect(() =>
      confirmBooking(aScheduledBooking(), { orderPaymentStatus: "refunded" }, LATER),
    ).toThrow(UnpaidConfirmationError);
    expect(() =>
      confirmBooking(aScheduledBooking(), { orderPaymentStatus: "partially_refunded" }, LATER),
    ).toThrow(UnpaidConfirmationError);
  });

  it("says which booking and which payment state, so an alert is actionable", () => {
    try {
      confirmBooking(aScheduledBooking(), { orderPaymentStatus: "pending" }, LATER);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as Error).name).toBe("UnpaidConfirmationError");
      expect((error as Error).message).toContain("bkg_1");
      expect((error as Error).message).toContain("pending");
    }
  });

  it("refuses to confirm a booking that holds no slot", () => {
    expect(() => confirmBooking(aBooking(), { orderPaymentStatus: "paid" }, LATER)).toThrow(
      InvalidTransitionError,
    );
  });

  it("is a no-op on a duplicate webhook for an already confirmed booking", () => {
    const confirmed = aScheduledBooking({ status: "confirmed" });
    const result = confirmBooking(confirmed, { orderPaymentStatus: "paid" }, LATER);
    expect(result.changed).toBe(false);
    expect(result.entity).toBe(confirmed);
  });

  it("keeps the existing meeting link when the caller supplies none", () => {
    const booking = aScheduledBooking({ meetingUrl: "https://teams.microsoft.com/l/original" });
    const result = confirmBooking(booking, { orderPaymentStatus: "paid" }, LATER);
    expect(result.entity.meetingUrl).toBe("https://teams.microsoft.com/l/original");
  });
});

describe("releaseBookingSlot", () => {
  it("clears the slot so nothing downstream reads a time the calendar lost", () => {
    const result = releaseBookingSlot(aScheduledBooking(), LATER);
    expect(result.changed).toBe(true);
    expect(result.entity.status).toBe("awaiting_schedule");
    expect(result.entity.scheduledStart).toBeNull();
    expect(result.entity.scheduledEnd).toBeNull();
    expect(result.entity.calendarEventId).toBeNull();
    expect(result.entity.meetingUrl).toBeNull();
  });

  it("is a no-op for a booking already awaiting a slot", () => {
    const waiting = aBooking();
    expect(releaseBookingSlot(waiting, LATER).changed).toBe(false);
  });

  it("refuses to un-schedule a completed session", () => {
    expect(() => releaseBookingSlot(aBooking({ status: "completed" }), LATER)).toThrow(
      InvalidTransitionError,
    );
  });
});

describe("completeBooking, markBookingNoShow and cancelBooking", () => {
  it("completes a confirmed booking", () => {
    const result = completeBooking(aScheduledBooking({ status: "confirmed" }), LATER);
    expect(result.entity.status).toBe("completed");
    expect(result.entity.updatedAt).toEqual(LATER);
  });

  it("marks a confirmed booking as a no-show", () => {
    expect(markBookingNoShow(aScheduledBooking({ status: "confirmed" }), LATER).entity.status).toBe(
      "no_show",
    );
  });

  it("refuses to complete a session that was never confirmed", () => {
    expect(() => completeBooking(aScheduledBooking(), LATER)).toThrow(InvalidTransitionError);
    expect(() => markBookingNoShow(aBooking(), LATER)).toThrow(InvalidTransitionError);
  });

  it("cancels from any state before the session happened", () => {
    expect(cancelBooking(aBooking(), LATER).entity.status).toBe("cancelled");
    expect(cancelBooking(aScheduledBooking(), LATER).entity.status).toBe("cancelled");
    expect(cancelBooking(aScheduledBooking({ status: "confirmed" }), LATER).entity.status).toBe(
      "cancelled",
    );
  });

  it("refuses to cancel a session that already happened", () => {
    expect(() => cancelBooking(aBooking({ status: "completed" }), LATER)).toThrow(
      InvalidTransitionError,
    );
    expect(() => cancelBooking(aBooking({ status: "no_show" }), LATER)).toThrow(
      InvalidTransitionError,
    );
  });

  it("is a no-op when cancelling an already cancelled booking", () => {
    const cancelled = aBooking({ status: "cancelled" });
    expect(cancelBooking(cancelled, LATER).changed).toBe(false);
  });
});
