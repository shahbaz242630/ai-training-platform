import { BOOKING_POLICY } from "@/config/site";

/**
 * Does this session start inside the customer's cancellation period?
 *
 * UK and EU consumers can cancel a distance contract for 14 days from the day
 * they book. A service may begin inside that period only at the consumer's
 * express request, with their acknowledgement that the right ends once the
 * service is fully delivered. Without that request, a consumer who cancels
 * after the session may owe nothing at all.
 *
 * So the booking page shows the request box, and the server insists on it,
 * whenever this is true. The server decides from the slot it re-derived, never
 * from anything the browser claims. Measured as elapsed time from the moment
 * of booking: any session starting less than 14 days later counts, which errs
 * on the side of asking.
 */
export function startsWithinCancellationPeriod(slotStart: Date, bookedAt: Date): boolean {
  const periodMs = BOOKING_POLICY.cancellationDays * 24 * 60 * 60 * 1000;
  return slotStart.getTime() - bookedAt.getTime() < periodMs;
}
