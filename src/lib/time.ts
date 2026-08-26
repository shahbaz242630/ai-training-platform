/**
 * Time utilities.
 *
 * Two rules hold everywhere in this codebase:
 *
 *  1. Every stored and computed instant is UTC. Conversion happens when
 *     something is rendered for a person, and nowhere else.
 *  2. Business hours are expressed in Gulf Standard Time, because that is
 *     where the sessions are actually delivered from.
 *
 * GST is UTC+4 all year - the UAE observes no daylight saving. That is what
 * makes the fixed-offset arithmetic below correct, and it is the only reason
 * it is correct. Do not copy this approach for any other zone: a zone with
 * DST needs a real timezone database, or it will be an hour wrong twice a year
 * and only in the weeks nobody is testing.
 */

/** Gulf Standard Time, UTC+4, no daylight saving. */
export const GST_OFFSET_MINUTES = 4 * 60;

/** The IANA zone name, for rendering with Intl where a real zone is needed. */
export const GST_TIMEZONE = "Asia/Dubai";

export const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** 0 is Sunday, matching JavaScript. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface GstParts {
  readonly year: number;
  /** 1-12, unlike the JavaScript convention, because 0-11 causes bugs in config files. */
  readonly month: number;
  readonly day: number;
  readonly weekday: Weekday;
  /** Minutes since GST midnight, so 09:30 is 570. */
  readonly minutesOfDay: number;
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MINUTE_MS);
}

export function addDays(instant: Date, days: number): Date {
  return new Date(instant.getTime() + days * DAY_MS);
}

/** How a UTC instant reads on a clock and calendar in Dubai. */
export function toGstParts(instant: Date): GstParts {
  const shifted = new Date(instant.getTime() + GST_OFFSET_MINUTES * MINUTE_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay() as Weekday,
    minutesOfDay: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/** The UTC instant at which the Dubai day containing `instant` began. */
export function gstDayStartUtc(instant: Date): Date {
  const shifted = new Date(instant.getTime() + GST_OFFSET_MINUTES * MINUTE_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - GST_OFFSET_MINUTES * MINUTE_MS);
}

/** A time of day in Dubai, on the Dubai day that started at `dayStartUtc`, as a UTC instant. */
export function gstTimeOnDayUtc(dayStartUtc: Date, minutesOfDay: number): Date {
  return addMinutes(dayStartUtc, minutesOfDay);
}

/**
 * The Dubai calendar date of a UTC instant, as YYYY-MM-DD.
 *
 * Shifting into the GST offset and taking the date part of the ISO string is
 * exact here precisely because the offset is fixed - the shifted instant's UTC
 * date and Dubai's calendar date are the same thing.
 */
export function gstIsoDate(instant: Date): string {
  const shifted = new Date(instant.getTime() + GST_OFFSET_MINUTES * MINUTE_MS);
  return shifted.toISOString().slice(0, 10);
}

/**
 * The UTC instant at which a given Dubai calendar date began, or null if the
 * value is not a date this understands.
 *
 * Returns null rather than a guess, because the value arrives in a URL that
 * anybody can edit and a silently-wrong date would show the wrong week.
 */
export function gstDayStartFromIsoDate(isoDate: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const midnight = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(midnight.getTime())) return null;
  // Round-trip check: "2026-02-31" parses in some engines but is not a real date.
  if (midnight.toISOString().slice(0, 10) !== isoDate) return null;
  return new Date(midnight.getTime() - GST_OFFSET_MINUTES * MINUTE_MS);
}

/** Minutes since midnight, for writing business hours readably in configuration. */
export function at(hour: number, minute = 0): number {
  return hour * 60 + minute;
}

export interface Interval {
  readonly start: Date;
  readonly end: Date;
}

/**
 * Half-open comparison: an interval ending exactly when the next begins does
 * not overlap it. Back-to-back sessions are adjacent, not conflicting - the
 * gap between them is a buffer, applied deliberately, not an accident of how
 * overlap is defined.
 */
export function intervalsOverlap(a: Interval, b: Interval): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

/** Grow an interval by the same number of minutes at each end. */
export function padInterval(interval: Interval, minutes: number): Interval {
  return {
    start: addMinutes(interval.start, -minutes),
    end: addMinutes(interval.end, minutes),
  };
}
