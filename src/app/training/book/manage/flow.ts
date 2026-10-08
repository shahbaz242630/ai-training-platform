import { z } from "zod";
import { contactLine } from "@/components/ui/ContactLink";
import { getSessionBySlug } from "@/config/sessions";
import type { QueryRunner } from "@/data/db";
import {
  isMoveCollision,
  loadBookingForManage,
  moveBooking,
  syncCalendarMove,
  type BookingForManage,
} from "@/data/reschedule";
import { isRetryableContention } from "@/data/slot-holds";
import {
  decideReschedule,
  moveWindowEnd,
  type RescheduleRefusal,
} from "@/domain/booking/reschedule";
import { bookingReference } from "@/domain/booking/withdrawal";
import type { SchedulingProvider, TimeSlot } from "@/domain/scheduling/provider";
import {
  describeInstant,
  presentSlots,
  type PresentedDay,
} from "@/domain/scheduling/slot-presentation";
import { logger } from "@/lib/logger";
import { readManageToken } from "@/lib/manage-link";
import { addMinutes } from "@/lib/time";

/** Shared with the sweep, so one search finds every instance. */
export const MISSING_EVENT_ALARM =
  "a moved session has no calendar event - put it back on the calendar by hand";

/**
 * Managing a booking from the link in the customer's email: see it, and move
 * it once to another open time.
 *
 * The link is the identity. Everything is decided again on the server when
 * the customer confirms: the link, the booking, the policy, and that the time
 * they chose is one we would offer right now. The browser only ever sends the
 * link and the start time it picked.
 */

export type FlowResult<T> =
  ({ readonly ok: true } & T) | { readonly ok: false; readonly message: string };

export type TransactionRunner = <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;

export interface ManageDeps {
  readonly transaction: TransactionRunner;
  readonly now: Date;
  readonly secret: string;
  /**
   * Open times right now, fresh from the calendar and the holds, looking as
   * far as `until` - past the 60 days a new booking sees, because a move may
   * go to any open time within 90 days of the original date.
   */
  readonly offered: (
    durationMinutes: number,
    now: Date,
    until: Date,
  ) => Promise<readonly TimeSlot[]>;
}

export interface ManageView {
  readonly reference: string;
  readonly sessionTitle: string;
  /** e.g. "Thursday, 10 September 2026 at 19:00 (Asia/Dubai)". */
  readonly sessionTime: string;
  /** Present when the booking can be moved: the times it can move to, by day. */
  readonly days: readonly PresentedDay[] | null;
  /** Present when it cannot: why, in words for the customer. */
  readonly notMovable: string | null;
}

export const LINK_MESSAGE = (): string =>
  "This link has expired or is not valid. You can get a new one with the email address you booked with.";

const TIME_GONE = "That time is no longer available. Please choose another.";
const TAKEN = "Someone has just booked that time. Please choose another.";
const BROKEN = "Something went wrong on our side. Please try again in a moment.";

const REFUSALS: Record<RescheduleRefusal | "not_found", () => string> = {
  already_moved: () =>
    `This booking has already been moved once, so its time is now final. If something has gone wrong, please ${contactLine()}.`,
  too_late: () =>
    "Your session starts in less than 24 hours, so it can no longer be moved. It goes ahead at the booked time.",
  not_movable: () =>
    `This booking cannot be moved online. Please ${contactLine()} and we will help.`,
  not_found: LINK_MESSAGE,
  outside_window: () => TIME_GONE,
  same_time: () => "That is the time you already have. Please choose a different one.",
  wrong_length: () => TIME_GONE,
};

export async function loadManageView(
  token: string,
  deps: ManageDeps,
): Promise<FlowResult<{ readonly view: ManageView }>> {
  const bookingId = readManageToken(token, deps.now, deps.secret);
  if (bookingId === null) return { ok: false, message: LINK_MESSAGE() };

  const booking = await deps.transaction((runner) => loadBookingForManage(runner, bookingId));
  // A link to a booking that no longer exists reads like any other dead link: ask for a new one.
  if (!booking) return { ok: false, message: LINK_MESSAGE() };
  const session = getSessionBySlug(booking.sessionSlug);
  if (!session || !booking.scheduledStart) {
    return { ok: false, message: REFUSALS.not_movable() };
  }

  const base = {
    reference: bookingReference(bookingId),
    sessionTitle: session.title,
    sessionTime: describeInstant(booking.scheduledStart, booking.customerTimezone),
  };

  // Asked with a placeholder time: everything but the new slot is known now.
  const policy = decideReschedule({
    status: booking.status,
    scheduledStart: booking.scheduledStart,
    scheduledEnd: booking.scheduledEnd,
    rescheduleCount: booking.rescheduleCount,
    newSlot: { start: deps.now, end: addMinutes(deps.now, session.durationMinutes) },
    now: deps.now,
  });
  if (!policy.ok && policy.reason !== "same_time" && policy.reason !== "wrong_length") {
    return { ok: true, view: { ...base, days: null, notMovable: REFUSALS[policy.reason]() } };
  }

  const slots = await movableSlots(booking, session.durationMinutes, deps);
  return {
    ok: true,
    view: { ...base, days: presentSlots(slots, booking.customerTimezone), notMovable: null },
  };
}

export const moveFormSchema = z
  .object({
    token: z.string().min(1).max(300),
    slotStart: z.string().datetime(),
  })
  .strict();

export async function confirmMove(
  input: unknown,
  deps: ManageDeps & { readonly calendar: Pick<SchedulingProvider, "moveEvent"> },
): Promise<FlowResult<{ readonly newTime: string }>> {
  const parsed = moveFormSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: TIME_GONE };

  const bookingId = readManageToken(parsed.data.token, deps.now, deps.secret);
  if (bookingId === null) return { ok: false, message: LINK_MESSAGE() };

  const booking = await deps.transaction((runner) => loadBookingForManage(runner, bookingId));
  const session = booking ? getSessionBySlug(booking.sessionSlug) : undefined;
  if (!booking || !session) return { ok: false, message: REFUSALS.not_movable() };

  // The time must be one we would offer right now, not merely one that is free.
  const start = new Date(parsed.data.slotStart);
  const offered = await movableSlots(booking, session.durationMinutes, deps);
  if (!offered.some((slot) => slot.start.getTime() === start.getTime())) {
    return { ok: false, message: TIME_GONE };
  }

  const attempt = () =>
    deps.transaction((runner) =>
      moveBooking(runner, {
        bookingId,
        newSlot: { start, end: addMinutes(start, session.durationMinutes) },
        now: deps.now,
      }),
    );
  let outcome;
  try {
    /*
      Under heavy contention Postgres can settle a race with a deadlock or
      serialization failure instead of the overlap error. That is "try once
      more", not a verdict: the retry either succeeds or loses definitely.
    */
    outcome = await attempt().catch((error: unknown) => {
      if (isRetryableContention(error)) return attempt();
      throw error;
    });
  } catch (error) {
    if (isMoveCollision(error) || isRetryableContention(error)) {
      return { ok: false, message: TAKEN };
    }
    throw error;
  }
  if (outcome.kind === "refused") return { ok: false, message: REFUSALS[outcome.reason]() };

  // The calendar straight away; if it is unreachable the sweep finishes the job.
  try {
    const synced = await syncCalendarMove({
      bookingId,
      provider: deps.calendar,
      transaction: deps.transaction,
    });
    if (synced === "event_missing") {
      // The flag is now cleared, so the sweep will not raise this: raise it here.
      logger.error(MISSING_EVENT_ALARM, { bookingId });
    }
  } catch (error) {
    // Left flagged in the database: the next sweep moves the event.
    logger.warn("a moved session's calendar event will be moved by the next sweep", {
      bookingId,
      error: (error as Error).message,
    });
  }

  return { ok: true, newTime: describeInstant(outcome.start, booking.customerTimezone) };
}

/** Open times inside the move window, other than the one the booking already has. */
async function movableSlots(
  booking: BookingForManage,
  durationMinutes: number,
  deps: ManageDeps,
): Promise<readonly TimeSlot[]> {
  if (!booking.scheduledStart) return [];
  const current = booking.scheduledStart.getTime();
  const lastStart = moveWindowEnd(booking.scheduledStart);
  const last = lastStart.getTime();
  // The search runs to the end of a session starting on the last allowed day.
  const slots = await deps.offered(
    durationMinutes,
    deps.now,
    addMinutes(lastStart, durationMinutes),
  );
  return slots.filter((s) => s.start.getTime() !== current && s.start.getTime() <= last);
}

export const MESSAGES = { TIME_GONE, TAKEN, BROKEN } as const;
