import { describe, expect, it } from "vitest";
import {
  bookingReference,
  decideWithdrawal,
  normaliseReference,
  withdrawalStatement,
  type WithdrawalFacts,
} from "./withdrawal";

const DAY = 24 * 60 * 60 * 1000;
const bookedAt = new Date("2026-10-01T10:00:00Z");

const facts = (over: Partial<WithdrawalFacts> = {}): WithdrawalFacts => ({
  bookingStatus: "confirmed",
  paymentStatus: "paid",
  bookedAt,
  scheduledStart: new Date(bookedAt.getTime() + 20 * DAY),
  amountPaidFils: 129_900,
  now: new Date(bookedAt.getTime() + 3 * DAY),
  ...over,
});

describe("bookingReference", () => {
  it("is the first eight hex characters of the booking id, upper case", () => {
    expect(bookingReference("3f9a1c2b-0d4e-4f00-9a11-222233334444")).toBe("3F9A1C2B");
  });
});

describe("normaliseReference", () => {
  it("accepts what people actually type: spaces, lower case, a leading hash", () => {
    expect(normaliseReference(" #3f9a 1c2b ")).toBe("3F9A1C2B");
  });

  it("refuses anything that is not eight hex characters", () => {
    expect(normaliseReference("3F9A1C2")).toBeNull();
    expect(normaliseReference("3F9A1C2BX")).toBeNull();
    expect(normaliseReference("ZZZZZZZZ")).toBeNull();
    expect(normaliseReference("")).toBeNull();
  });
});

describe("decideWithdrawal", () => {
  it("refunds the full amount paid while the session has not started, inside 14 days", () => {
    expect(decideWithdrawal(facts())).toEqual({ ok: true, refundDueFils: 129_900 });
  });

  it("allows a booking still waiting for a time", () => {
    expect(
      decideWithdrawal(facts({ bookingStatus: "awaiting_schedule", scheduledStart: null })),
    ).toEqual({ ok: true, refundDueFils: 129_900 });
  });

  it("allows it up to the last moment of the 14 days", () => {
    const now = new Date(bookedAt.getTime() + 14 * DAY - 1);
    expect(decideWithdrawal(facts({ now })).ok).toBe(true);
  });

  it("refuses after the 14 days", () => {
    const now = new Date(bookedAt.getTime() + 14 * DAY);
    expect(decideWithdrawal(facts({ now }))).toEqual({ ok: false, reason: "period_over" });
  });

  it("refuses once the session has started, which needs a person to work out what was delivered", () => {
    const start = new Date(bookedAt.getTime() + 2 * DAY);
    expect(decideWithdrawal(facts({ scheduledStart: start }))).toEqual({
      ok: false,
      reason: "session_started",
    });
  });

  it("refuses a booking that is not paid", () => {
    expect(decideWithdrawal(facts({ paymentStatus: "pending" }))).toEqual({
      ok: false,
      reason: "not_paid",
    });
  });

  it("refuses a booking that is already closed", () => {
    for (const bookingStatus of ["cancelled", "completed", "no_show"] as const) {
      expect(decideWithdrawal(facts({ bookingStatus }))).toEqual({
        ok: false,
        reason: "closed",
      });
    }
  });
});

describe("withdrawalStatement", () => {
  it("states the withdrawal in the customer's own name, for the session and reference", () => {
    expect(
      withdrawalStatement({
        fullName: "Amina Khan",
        sessionTitle: "Claude, Claude Code & Advanced Workflows",
        reference: "3F9A1C2B",
      }),
    ).toBe(
      "I, Amina Khan, withdraw from my contract for the coaching session " +
        '"Claude, Claude Code & Advanced Workflows" (booking reference 3F9A1C2B).',
    );
  });
});
