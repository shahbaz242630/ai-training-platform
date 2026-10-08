import { at, type Weekday } from "@/lib/time";

/**
 * When sessions can be booked.
 *
 * THE single source of truth for availability rules. The scheduling provider
 * generates slots from these and from the calendar; no component invents its
 * own hours.
 *
 * The hours are the founder's, confirmed 2026-10-08: two 90-minute sessions
 * every evening, 7:00-8:30pm and 9:00-10:30pm Dubai time, seven days a week,
 * with the break between them. The 120-minute slot interval is what makes it
 * exactly two: a session can only start at 7pm or 9pm, so no 7:30 booking can
 * swallow the whole evening. Getting this wrong does not fail loudly - it
 * silently offers a customer a time nobody intends to be available - so
 * `availability.test.ts` pins these exact starts.
 */

export interface AvailabilityWindow {
  readonly weekday: Weekday;
  /** Minutes since midnight, Dubai time. */
  readonly startMinutes: number;
  readonly endMinutes: number;
}

export interface AvailabilityRules {
  readonly windows: readonly AvailabilityWindow[];
  /** How often a session may start within a window, in minutes. */
  readonly slotIntervalMinutes: number;
  /** Quiet time kept clear either side of every booked session. */
  readonly bufferMinutes: number;
  /** Nothing may be booked sooner than this - there has to be time to prepare. */
  readonly minimumNoticeHours: number;
  /** Nothing may be booked further ahead than this. */
  readonly bookingHorizonDays: number;
}

const EVERY_DAY: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

/** Every evening, 7:00 to 10:30pm Dubai time. */
const EVENING_WINDOWS: readonly AvailabilityWindow[] = EVERY_DAY.map((weekday) => ({
  weekday,
  startMinutes: at(19),
  endMinutes: at(22, 30),
}));

export const AVAILABILITY: AvailabilityRules = {
  windows: EVENING_WINDOWS,
  slotIntervalMinutes: 120,
  bufferMinutes: 15,
  minimumNoticeHours: 24,
  bookingHorizonDays: 60,
};

export function windowsForWeekday(
  rules: AvailabilityRules,
  weekday: Weekday,
): readonly AvailabilityWindow[] {
  return rules.windows.filter((window) => window.weekday === weekday);
}
