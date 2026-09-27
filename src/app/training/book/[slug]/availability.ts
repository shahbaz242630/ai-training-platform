import { withTransaction } from "@/data/db";
import { listLiveHolds } from "@/data/slot-holds";
import { isSlotAvailable } from "@/domain/booking/slot-hold";
import { getSchedulingProvider } from "@/domain/scheduling/factory";
import type { TimeSlot } from "@/domain/scheduling/provider";
import { AVAILABILITY } from "@/config/availability";
import { addDays } from "@/lib/time";
import { createSingleFlightCache } from "@/lib/single-flight-cache";

/**
 * What a customer may be offered, decided in one place.
 *
 * The page and the reserve action MUST agree on this. If the page offered a
 * slot the action then refused, a customer would be told to pick a time that
 * was never bookable - so both call this rather than each computing their own
 * idea of availability.
 *
 * Two filters, in order:
 *
 *   1. The scheduling rules - working hours, buffers, notice, horizon, and
 *      whatever is already on the calendar.
 *   2. Live slot holds - somebody is part-way through paying for that time.
 *
 * The second is a database read, and that is deliberate: a hold taken by
 * another customer thirty seconds ago must disappear from this list, and only
 * the database knows about it.
 *
 * The provider comes from the factory: the real calendar when it is
 * configured, the in-memory one outside production when it is not, and a
 * refusal in production - which the page reports honestly rather than
 * offering times nobody checked.
 */
export async function offeredSlots(
  durationMinutes: number,
  now: Date,
): Promise<readonly TimeSlot[]> {
  const to = addDays(now, AVAILABILITY.bookingHorizonDays);

  const scheduler = getSchedulingProvider();
  const candidates = await scheduler.listAvailability({ from: now, to, durationMinutes });

  const holds = await withTransaction((runner) => listLiveHolds(runner, { from: now, to }, now));

  return candidates.filter((slot) => isSlotAvailable(slot, holds, now));
}

/*
  The booking PAGE reads through this; checkout never does.

  Every page view used to read the calendar from Microsoft Graph and the holds
  from the database. Graph allows four concurrent requests per mailbox, so a
  small flood of page loads got the mailbox throttled and real customers saw no
  times (security audit, 2026-09-27). Now the answer is loaded at most once per
  window per session length, and a flood of views shares it.

  The cost is that the page can lag the diary by up to the window: a time
  somebody took seconds ago may still be shown. That is safe because checkout
  calls `offeredSlots` itself, fresh, and a customer who picks a time that has
  gone is told so and shown what is left - the same path as losing a race.
*/
const PAGE_AVAILABILITY_TTL_MS = 30_000;
const pageAvailability = createSingleFlightCache<number, readonly TimeSlot[]>({
  ttlMs: PAGE_AVAILABILITY_TTL_MS,
});

export async function offeredSlotsForPage(
  durationMinutes: number,
  now: Date,
): Promise<readonly TimeSlot[]> {
  const slots = await pageAvailability.get(durationMinutes, now, () =>
    offeredSlots(durationMinutes, now),
  );
  return stillBookable(slots, now);
}

/**
 * A cached list re-checked against the clock: a time that has come inside the
 * minimum notice since the list was loaded is not offered.
 */
export function stillBookable(slots: readonly TimeSlot[], now: Date): readonly TimeSlot[] {
  const earliest = now.getTime() + AVAILABILITY.minimumNoticeHours * 60 * 60_000;
  return slots.filter((slot) => slot.start.getTime() >= earliest);
}
