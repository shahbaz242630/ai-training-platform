import { at, type Weekday } from "@/lib/time";

/**
 * When sessions can be booked.
 *
 * THE single source of truth for availability rules. The scheduling provider
 * generates slots from these and from the calendar; no component invents its
 * own hours.
 *
 * ============================================================================
 * THE HOURS BELOW ARE PLACEHOLDERS AND HAVE NOT BEEN CONFIRMED.
 *
 * They exist so the booking flow can be built and tested end to end. They are
 * a guess at a working pattern, not a decision, and no customer has seen them:
 * nothing renders availability yet, and the whole site is noindex.
 *
 * Replace them with real hours before any booking surface goes live. Getting
 * this wrong does not fail loudly - it silently offers a customer a time
 * nobody intends to be available, and that is discovered when someone does not
 * turn up to a session they paid for.
 * ============================================================================
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

const MONDAY: Weekday = 1;
const TUESDAY: Weekday = 2;
const WEDNESDAY: Weekday = 3;
const THURSDAY: Weekday = 4;
const SATURDAY: Weekday = 6;

/** Weekday evenings and Saturday daytime. PLACEHOLDER - see the note above. */
const PLACEHOLDER_WINDOWS: readonly AvailabilityWindow[] = [
  { weekday: MONDAY, startMinutes: at(18), endMinutes: at(21, 30) },
  { weekday: TUESDAY, startMinutes: at(18), endMinutes: at(21, 30) },
  { weekday: WEDNESDAY, startMinutes: at(18), endMinutes: at(21, 30) },
  { weekday: THURSDAY, startMinutes: at(18), endMinutes: at(21, 30) },
  { weekday: SATURDAY, startMinutes: at(10), endMinutes: at(16) },
];

export const AVAILABILITY: AvailabilityRules = {
  windows: PLACEHOLDER_WINDOWS,
  slotIntervalMinutes: 30,
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
