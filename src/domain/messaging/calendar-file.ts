/**
 * An "add to calendar" file (iCalendar, RFC 5545) for a booked session.
 *
 * The customer is never invited to the calendar event: an invitation would
 * come from the coach's own mailbox, and every message a customer receives
 * comes from the booking desk. So the booking desk's confirmation carries
 * this file instead, and opening it adds the session to their calendar.
 *
 * It is PUBLISHED, not a REQUEST: no organiser and no attendee, so a
 * calendar treats it as an entry to add, never as a meeting to answer. The
 * UID is stable per booking and the SEQUENCE rises with each change, so a
 * later file for the same booking replaces the earlier entry instead of
 * adding a second one.
 */

export interface CalendarFileInput {
  /** Stable for the life of the booking. */
  readonly uid: string;
  /** 0 for the first file; one higher for every later version. */
  readonly sequence: number;
  readonly start: Date;
  readonly end: Date;
  /** When this file was made. */
  readonly stamp: Date;
  readonly summary: string;
  readonly description: string;
  /** The join link. */
  readonly url: string;
}

const PRODUCT_ID = "-//Zaaheen//Knowledge Centre bookings//EN";
const REMINDER_MINUTES = 15;
const MAX_LINE_BYTES = 75;

export function buildCalendarFile(input: CalendarFileInput): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${PRODUCT_ID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${input.uid}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${utc(input.stamp)}`,
    `DTSTART:${utc(input.start)}`,
    `DTEND:${utc(input.end)}`,
    `SUMMARY:${text(input.summary)}`,
    `DESCRIPTION:${text(input.description)}`,
    "LOCATION:Microsoft Teams",
    `URL:${input.url}`,
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${text(input.summary)}`,
    `TRIGGER:-PT${REMINDER_MINUTES}M`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

/** 2026-09-10T15:00:00.000Z -> 20260910T150000Z */
function utc(instant: Date): string {
  return instant
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** The format reserves backslash, semicolon and comma in text, and writes a newline as \n. */
function text(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Lines longer than 75 bytes continue on the next line after one space.
 * Counted in bytes, not characters, and never split inside a character.
 */
function fold(line: string): string {
  const encoder = new TextEncoder();
  const parts: string[] = [];
  let current = "";
  let currentBytes = 0;
  // The first line may use all 75 bytes; a continuation spends one on its space.
  let limit = MAX_LINE_BYTES;
  for (const character of line) {
    const bytes = encoder.encode(character).length;
    if (currentBytes + bytes > limit) {
      parts.push(current);
      current = "";
      currentBytes = 0;
      limit = MAX_LINE_BYTES - 1;
    }
    current += character;
    currentBytes += bytes;
  }
  parts.push(current);
  return parts.join("\r\n ");
}
