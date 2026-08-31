import { z } from "zod";
import { addMinutes } from "@/lib/time";

/**
 * Deciding whether a slot a browser asked for may actually be held.
 *
 * Kept apart from the server action so the rule is testable without a
 * database, a request or a rendered page. The action is the boundary; this is
 * the judgement it applies.
 *
 * THE POINT OF THIS MODULE: a browser sends an instant, and a browser can be
 * told anything. Checking only that nothing else is booked at that instant
 * would happily hold 03:00 on a Sunday, because nothing is booked then - the
 * slot has to be one we actually offered, not merely one that is free.
 */

export const reserveSlotRequestSchema = z
  .object({
    slug: z.string().min(1).max(100),
    /** The UTC instant, exactly as it was offered. Never a local wall-clock time. */
    slotStart: z.string().datetime(),
  })
  // Strict, so a request carrying keys it was never offered is refused rather
  // than quietly ignored - the same rule the intake schema follows.
  .strict();

export type ReserveSlotRequest = z.infer<typeof reserveSlotRequestSchema>;

export type ReserveSlotRefusal =
  /** The instant is not one we offered: outside working hours, in the past, or invented. */
  | "not_offered"
  /** Somebody else got there first. Expected, not an error. */
  | "slot_taken";

/**
 * Is this instant one of the slots we are currently offering?
 *
 * Compared on the exact millisecond rather than by overlap. An offered slot is
 * a specific start time; something that merely falls inside one is not a slot
 * we published, and accepting it would let a request drift a session ten
 * minutes off the grid every buffer calculation assumes.
 */
export function isOfferedSlot(requested: Date, offered: readonly { start: Date }[]): boolean {
  const wanted = requested.getTime();
  return offered.some((slot) => slot.start.getTime() === wanted);
}

/** The interval a hold covers: exactly the session, with no buffer smuggled in. */
export function holdInterval(
  slotStart: Date,
  durationMinutes: number,
): { readonly start: Date; readonly end: Date } {
  return { start: slotStart, end: addMinutes(slotStart, durationMinutes) };
}
