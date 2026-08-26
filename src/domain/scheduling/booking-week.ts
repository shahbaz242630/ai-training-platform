import { addDays, gstDayStartFromIsoDate, gstDayStartUtc, gstIsoDate } from "@/lib/time";

/**
 * Which week of availability the booking page is showing.
 *
 * Three weeks of every open evening is a wall of buttons nobody reads. A week
 * at a time, with plain links to move between them, is easier to scan - and
 * because the week lives in the URL rather than in component state, it needs
 * no JavaScript, survives a refresh, and can be linked to directly.
 *
 * The requested week arrives in a query string that anybody can edit, so it is
 * validated and clamped rather than trusted. Nothing here can be asked to show
 * a week in the past or beyond the booking horizon.
 */

export const DAYS_PER_PAGE = 7;

export interface BookingWeek {
  /** UTC instant at which the first Dubai day of this page began. */
  readonly startUtc: Date;
  /** Exclusive end: the instant the day after the last one begins. */
  readonly endUtc: Date;
  /** The first day, as a Dubai calendar date. Used in links. */
  readonly isoDate: string;
  /** Null when there is nothing earlier to show, so the control can be hidden. */
  readonly previousIsoDate: string | null;
  /** Null when the next page would be entirely beyond the booking horizon. */
  readonly nextIsoDate: string | null;
  /** True when showing the week containing today. */
  readonly isCurrent: boolean;
}

export function resolveBookingWeek(
  requestedIsoDate: string | undefined,
  now: Date,
  horizonDays: number,
): BookingWeek {
  const today = gstDayStartUtc(now);
  const lastBookableDay = gstDayStartUtc(addDays(now, horizonDays));

  const requested = requestedIsoDate ? gstDayStartFromIsoDate(requestedIsoDate) : null;

  // Clamp rather than reject: an out-of-range week in a URL is far more likely
  // to be a stale link than an attack, and showing the nearest sensible week
  // is more useful than an error page.
  let startUtc = requested ?? today;
  if (startUtc.getTime() < today.getTime()) startUtc = today;
  if (startUtc.getTime() > lastBookableDay.getTime()) startUtc = lastBookableDay;

  const previous = addDays(startUtc, -DAYS_PER_PAGE);
  const next = addDays(startUtc, DAYS_PER_PAGE);

  return {
    startUtc,
    endUtc: addDays(startUtc, DAYS_PER_PAGE),
    isoDate: gstIsoDate(startUtc),
    previousIsoDate:
      startUtc.getTime() <= today.getTime()
        ? null
        : gstIsoDate(previous.getTime() < today.getTime() ? today : previous),
    nextIsoDate: next.getTime() > lastBookableDay.getTime() ? null : gstIsoDate(next),
    isCurrent: startUtc.getTime() === today.getTime(),
  };
}
