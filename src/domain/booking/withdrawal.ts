import { BOOKING_POLICY } from "@/config/site";
import type { Fils } from "@/lib/money";
import type { BookingStatus } from "./booking";

/**
 * Withdrawing from a booking: the UK and EU consumer's right to cancel within
 * 14 days, offered online as "withdraw from contract here".
 *
 * Only the cases that need no judgement are decided here. A paid booking
 * whose session has not started, inside the 14 days, is refunded in full, and
 * the form can say so. Everything else (the session has started, so part of
 * it may have been delivered; the 14 days are over; the booking is closed) is
 * refused online and handed to a person by email, because getting it wrong in
 * either direction is a refund owed or a refund wrongly promised.
 */

/** What a customer quotes to identify a booking: eight hex characters of its id. */
export function bookingReference(bookingId: string): string {
  return bookingId.replace(/-/g, "").slice(0, 8).toUpperCase();
}

/** A reference as typed, made comparable; null if it cannot be one. */
export function normaliseReference(typed: string): string | null {
  const cleaned = typed.replace(/[\s#-]/g, "").toUpperCase();
  return /^[0-9A-F]{8}$/.test(cleaned) ? cleaned : null;
}

export interface WithdrawalFacts {
  readonly bookingStatus: BookingStatus;
  readonly paymentStatus: string;
  /** When the contract was made: the later of the order and the booking being created. */
  readonly bookedAt: Date;
  readonly scheduledStart: Date | null;
  readonly amountPaidFils: Fils;
  readonly now: Date;
}

export type WithdrawalRefusal = "not_paid" | "closed" | "period_over" | "session_started";

export type WithdrawalDecision =
  | { readonly ok: true; readonly refundDueFils: Fils }
  | { readonly ok: false; readonly reason: WithdrawalRefusal };

const OPEN_STATUSES: readonly BookingStatus[] = ["awaiting_schedule", "scheduled", "confirmed"];

export function decideWithdrawal(facts: WithdrawalFacts): WithdrawalDecision {
  if (facts.paymentStatus !== "paid") return { ok: false, reason: "not_paid" };
  if (!OPEN_STATUSES.includes(facts.bookingStatus)) return { ok: false, reason: "closed" };

  const periodEnds = facts.bookedAt.getTime() + BOOKING_POLICY.cancellationDays * 24 * 3_600_000;
  if (facts.now.getTime() >= periodEnds) return { ok: false, reason: "period_over" };

  if (facts.scheduledStart !== null && facts.now.getTime() >= facts.scheduledStart.getTime()) {
    return { ok: false, reason: "session_started" };
  }
  return { ok: true, refundDueFils: facts.amountPaidFils };
}

/** The notice, in the words the customer confirms and the record keeps. */
export function withdrawalStatement(input: {
  readonly fullName: string;
  readonly sessionTitle: string;
  readonly reference: string;
}): string {
  return (
    `I, ${input.fullName}, withdraw from my contract for the coaching session ` +
    `"${input.sessionTitle}" (booking reference ${input.reference}).`
  );
}
