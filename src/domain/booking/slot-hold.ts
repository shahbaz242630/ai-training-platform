import { intervalsOverlap } from "@/lib/time";
import { assertTransition, type TransitionResult, type TransitionTable } from "./transitions";

/**
 * A SlotHold is a temporary claim on a time slot while a customer pays.
 *
 * Microsoft Graph has no native "hold" primitive, so we implement one. The
 * problem it solves: a customer reaches checkout, and for the two minutes they
 * spend entering a card, nothing stops a second customer buying the same slot.
 * The hold blocks it, and a tentative calendar event blocks the real calendar
 * at the same time.
 *
 * The failure mode a hold must never have is blocking a slot forever. An
 * abandoned checkout leaves a hold nobody will ever convert, so expiry is not
 * optional bookkeeping - it is what stops an abandoned browser tab quietly
 * taking a sellable slot off the calendar. Expiry is enforced twice, and the
 * two are independent on purpose:
 *
 *   1. Reading: an expired hold stops blocking the moment it expires, whether
 *      or not anything has swept it. Availability is never wrong because a
 *      cron run was late or did not happen.
 *   2. Sweeping: a scheduled pass moves expired holds to `expired` and
 *      releases the tentative calendar event, which is the part that actually
 *      needs a job to run.
 */

export type SlotHoldStatus = "held" | "converted" | "expired" | "released";

/**
 * Long enough to pay by card, short enough that an abandoned checkout costs
 * little - and deliberately LONGER than the payment session it protects.
 *
 * The processor will not expire a checkout session sooner than 30 minutes
 * after it is created. A 15-minute hold therefore left a 15-minute window in
 * which a customer could still pay, having already lost their slot: charged,
 * with no session, needing a manual rescue. The hold now outlives the session
 * by five minutes, so anything the processor still accepts has a slot waiting
 * for it.
 *
 * Change this and CHECKOUT_SESSION_TTL_MINUTES together, or that window
 * reopens silently.
 */
export const DEFAULT_HOLD_TTL_MINUTES = 35;

export interface SlotHold {
  readonly id: string;
  /** UTC, both. */
  readonly slotStart: Date;
  readonly slotEnd: Date;
  /** Null while a slot is held before an order exists. */
  readonly orderId: string | null;
  /** The tentative Graph event blocking the real calendar. */
  readonly calendarEventId: string | null;
  readonly expiresAt: Date;
  readonly status: SlotHoldStatus;
  readonly createdAt: Date;
}

/**
 * `held` is the only live state. The other three are all terminal and differ
 * only in why the hold ended, which matters when reading back what happened:
 * `converted` means it became a booking, `expired` means nobody paid in time,
 * `released` means something deliberately gave it up.
 */
const HOLD_TRANSITIONS: TransitionTable<SlotHoldStatus> = {
  held: ["converted", "expired", "released"],
  converted: [],
  expired: [],
  released: [],
};

export class SlotHoldShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlotHoldShapeError";
  }
}

export interface CreateSlotHoldInput {
  readonly id: string;
  /** UTC, and start must precede end. */
  readonly slotStart: Date;
  readonly slotEnd: Date;
  readonly orderId?: string | null;
  readonly calendarEventId?: string | null;
  readonly ttlMinutes?: number;
  readonly now: Date;
}

export function createSlotHold(input: CreateSlotHoldInput): SlotHold {
  if (input.slotStart.getTime() >= input.slotEnd.getTime()) {
    throw new SlotHoldShapeError("A slot must start before it ends");
  }
  const ttlMinutes = input.ttlMinutes ?? DEFAULT_HOLD_TTL_MINUTES;
  if (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0) {
    throw new SlotHoldShapeError("ttlMinutes must be a positive number");
  }

  return {
    id: input.id,
    slotStart: input.slotStart,
    slotEnd: input.slotEnd,
    orderId: input.orderId ?? null,
    calendarEventId: input.calendarEventId ?? null,
    expiresAt: new Date(input.now.getTime() + ttlMinutes * 60_000),
    status: "held",
    createdAt: input.now,
  };
}

/** Past its expiry, whether or not a sweep has caught up with it yet. */
export function hasExpired(hold: SlotHold, now: Date): boolean {
  return now.getTime() >= hold.expiresAt.getTime();
}

/**
 * Whether this hold is still counting down.
 *
 * Deliberately not just `status === "held"`: a hold that expired thirty
 * seconds ago is not counting down, even though no sweep has run.
 */
export function isHoldActive(hold: SlotHold, now: Date): boolean {
  return hold.status === "held" && !hasExpired(hold, now);
}

/**
 * Whether this hold takes its slot off the market.
 *
 * NOT the same question as `isHoldActive`, and conflating the two is what
 * allowed the same time to be sold twice. A `converted` hold has no countdown
 * left to run - somebody has PAID for that slot - so it blocks permanently
 * and is the single most important case here. Only `expired` and `released`
 * put a slot back on sale.
 */
export function blocksSlot(hold: SlotHold, now: Date): boolean {
  if (hold.status === "converted") return true;
  return isHoldActive(hold, now);
}

/** Payment verified - the hold becomes a booking and the tentative event is confirmed. */
export function convertHold(hold: SlotHold): TransitionResult<SlotHold> {
  return endHold(hold, "converted");
}

/** Nobody paid in time. Reached by the sweep. */
export function expireHold(hold: SlotHold): TransitionResult<SlotHold> {
  return endHold(hold, "expired");
}

/** Deliberately given up - checkout abandoned, cancelled, or payment failed. */
export function releaseHold(hold: SlotHold): TransitionResult<SlotHold> {
  return endHold(hold, "released");
}

function endHold(hold: SlotHold, to: SlotHoldStatus): TransitionResult<SlotHold> {
  const changed = assertTransition("SlotHold", HOLD_TRANSITIONS, hold.status, to);
  if (!changed) return { entity: hold, changed: false };
  return { entity: { ...hold, status: to }, changed: true };
}

/**
 * The hold standing in the way of this slot, if any.
 *
 * Returns the hold rather than a boolean so a caller can say what is blocking
 * and until when, which is the difference between a useful message and
 * "unavailable".
 */
export function findBlockingHold(
  slot: { start: Date; end: Date },
  holds: readonly SlotHold[],
  now: Date,
): SlotHold | undefined {
  return holds.find(
    (hold) =>
      blocksSlot(hold, now) && intervalsOverlap(slot, { start: hold.slotStart, end: hold.slotEnd }),
  );
}

export function isSlotAvailable(
  slot: { start: Date; end: Date },
  holds: readonly SlotHold[],
  now: Date,
): boolean {
  return findBlockingHold(slot, holds, now) === undefined;
}

/**
 * The cron sweep. Returns only the holds it changed, so a caller writes and
 * alerts on exactly those - and so an empty result is a genuine "nothing to
 * do" rather than an unreadable full list.
 *
 * Each returned hold still carries its `calendarEventId`: the tentative event
 * has to be deleted too, or the slot stays blocked on the real calendar even
 * though the hold is gone.
 */
export function sweepExpiredHolds(holds: readonly SlotHold[], now: Date): readonly SlotHold[] {
  return holds
    .filter((hold) => hold.status === "held" && hasExpired(hold, now))
    .map((hold) => expireHold(hold).entity);
}
