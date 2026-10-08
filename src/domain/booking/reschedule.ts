import { BOOKING_POLICY } from "@/config/site";
import { addDays, addMinutes } from "@/lib/time";
import type { BookingStatus } from "./booking";

/**
 * Whether a customer may move their session to a new time.
 *
 * The published policy, as a decision: a confirmed session can be moved once,
 * free, if the customer asks at least 24 hours before it starts, to an open
 * time within 90 days of the original date. Every number comes from
 * BOOKING_POLICY, the same place the policy page and the terms read them.
 *
 * Whether the new time is OPEN - inside working hours, past the minimum
 * notice, free on the calendar - is the scheduling rules' question, asked by
 * the caller with the live calendar. This decides only what the policy says
 * about moving. Moves we make never count against the customer: they do not
 * come through here.
 */

export interface RescheduleInput {
  readonly status: BookingStatus;
  readonly scheduledStart: Date | null;
  readonly scheduledEnd: Date | null;
  /** How many times the customer has already moved this booking. */
  readonly rescheduleCount: number;
  readonly newSlot: { readonly start: Date; readonly end: Date };
  readonly now: Date;
}

export type RescheduleRefusal =
  "not_movable" | "already_moved" | "too_late" | "outside_window" | "same_time" | "wrong_length";

export type RescheduleDecision =
  { readonly ok: true } | { readonly ok: false; readonly reason: RescheduleRefusal };

export function decideReschedule(input: RescheduleInput): RescheduleDecision {
  const { scheduledStart, scheduledEnd, newSlot } = input;
  if (input.status !== "confirmed" || scheduledStart === null || scheduledEnd === null) {
    return { ok: false, reason: "not_movable" };
  }
  if (input.rescheduleCount >= BOOKING_POLICY.movesPerBooking) {
    return { ok: false, reason: "already_moved" };
  }

  const lastMoment = addMinutes(scheduledStart, -BOOKING_POLICY.moveNoticeHours * 60);
  if (input.now.getTime() > lastMoment.getTime()) {
    return { ok: false, reason: "too_late" };
  }

  if (newSlot.start.getTime() === scheduledStart.getTime()) {
    return { ok: false, reason: "same_time" };
  }
  const length = scheduledEnd.getTime() - scheduledStart.getTime();
  if (newSlot.end.getTime() - newSlot.start.getTime() !== length) {
    return { ok: false, reason: "wrong_length" };
  }
  if (newSlot.start.getTime() > addDays(scheduledStart, BOOKING_POLICY.moveWindowDays).getTime()) {
    return { ok: false, reason: "outside_window" };
  }

  return { ok: true };
}

/** The last day a moved session may start on: 90 days after the original. */
export function moveWindowEnd(originalStart: Date): Date {
  return addDays(originalStart, BOOKING_POLICY.moveWindowDays);
}
