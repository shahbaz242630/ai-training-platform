import { withTransaction } from "@/data/db";
import { listLiveHolds } from "@/data/slot-holds";
import { isSlotAvailable } from "@/domain/booking/slot-hold";
import { getSchedulingProvider } from "@/domain/scheduling/factory";
import type { TimeSlot } from "@/domain/scheduling/provider";
import { AVAILABILITY } from "@/config/availability";
import { addDays } from "@/lib/time";

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
