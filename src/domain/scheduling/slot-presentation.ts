import { GST_TIMEZONE } from "@/lib/time";
import type { TimeSlot } from "./provider";

/**
 * Turning UTC slots into something a person can read.
 *
 * Slots are stored, compared and submitted as UTC instants. They are converted
 * exactly once, here, at the point of being shown to somebody - and the value
 * a form posts back is always the UTC instant, never the string a customer
 * read. A booking system that round-trips a formatted local time has already
 * lost the information needed to know which instant was meant.
 *
 * Two rules this module exists to enforce:
 *
 *  1. Days are grouped by the CUSTOMER'S calendar day, not ours and not UTC's.
 *     A slot at 18:00 in Dubai is the next morning in Auckland. Grouping it
 *     under our day would file it under a date the customer never sees, and
 *     they would look for it on the wrong day.
 *
 *  2. A Gulf Standard Time reference is shown only when it says something. For
 *     a customer already in that offset it is noise, and noise trains people
 *     to stop reading.
 */

/** 24-hour, so an am/pm misread cannot cost someone the session they paid for. */
const LOCALE = "en-GB";

export interface PresentedSlot {
  /** The authoritative value. What a form posts back, always. */
  readonly isoStart: string;
  readonly start: Date;
  readonly end: Date;
  /** e.g. "18:00 - 19:30", in the customer's own zone. */
  readonly localTime: string;
  /**
   * e.g. "22:00 GST", or "22:00 GST, Sat 12 Sept" when that is a different
   * calendar day for us than for them. Null when the customer's clock already
   * reads the same, which makes it redundant.
   */
  readonly gstReference: string | null;
}

export interface PresentedDay {
  /** YYYY-MM-DD in the customer's zone. A stable key, not for display. */
  readonly isoDate: string;
  /** e.g. "Saturday, 12 September 2026". The year is always shown - a booking horizon can cross one. */
  readonly label: string;
  readonly slots: readonly PresentedSlot[];
}

export class InvalidTimeZoneError extends Error {
  constructor(timeZone: string) {
    super(`Unknown time zone: "${timeZone}"`);
    this.name = "InvalidTimeZoneError";
  }
}

/**
 * Group slots into the customer's days, in order, each slot rendered in their
 * zone.
 *
 * Throws on a zone the runtime does not know rather than quietly falling back
 * to ours. A silent fallback would show every customer Dubai times labelled as
 * their own, which is worse than an error because nothing looks wrong.
 */
export function presentSlots(
  slots: readonly TimeSlot[],
  timeZone: string,
): readonly PresentedDay[] {
  assertKnownTimeZone(timeZone);

  const days = new Map<string, { label: string; slots: PresentedSlot[] }>();

  for (const slot of [...slots].toSorted((a, b) => a.start.getTime() - b.start.getTime())) {
    const isoDate = dayKey(slot.start, timeZone);
    const day = days.get(isoDate) ?? { label: formatDayLabel(slot.start, timeZone), slots: [] };
    day.slots.push(presentSlot(slot, timeZone));
    days.set(isoDate, day);
  }

  // Slots were sorted before insertion and Map keeps insertion order, so the
  // days come out chronologically without a second sort.
  return [...days.entries()].map(([isoDate, day]) => ({
    isoDate,
    label: day.label,
    slots: day.slots,
  }));
}

export function presentSlot(slot: TimeSlot, timeZone: string): PresentedSlot {
  assertKnownTimeZone(timeZone);

  const localStart = formatTime(slot.start, timeZone);
  const localEnd = formatTime(slot.end, timeZone);
  const gstStart = formatTime(slot.start, GST_TIMEZONE);

  const sameClock = gstStart === localStart;
  const sameDay = dayKey(slot.start, timeZone) === dayKey(slot.start, GST_TIMEZONE);

  let gstReference: string | null = null;
  if (!sameClock || !sameDay) {
    gstReference = sameDay
      ? `${gstStart} GST`
      : `${gstStart} GST, ${formatShortDate(slot.start, GST_TIMEZONE)}`;
  }

  return {
    isoStart: slot.start.toISOString(),
    start: slot.start,
    end: slot.end,
    localTime: `${localStart} - ${localEnd}`,
    gstReference,
  };
}

export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone });
    return true;
  } catch {
    return false;
  }
}

function assertKnownTimeZone(timeZone: string): void {
  if (!isKnownTimeZone(timeZone)) throw new InvalidTimeZoneError(timeZone);
}

/** YYYY-MM-DD as that zone's calendar reads it. Assembled from parts rather than parsed out of a formatted string. */
function dayKey(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function formatTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    // Pinned rather than left to the locale default, so the rendering cannot
    // change underneath us when ICU data is updated.
    hourCycle: "h23",
  }).format(instant);
}

function formatDayLabel(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(instant);
}

function formatShortDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(instant);
}
