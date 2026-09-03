import { windowsForWeekday, type AvailabilityRules } from "@/config/availability";
import {
  addDays,
  addMinutes,
  gstDayStartUtc,
  gstTimeOnDayUtc,
  intervalsOverlap,
  padInterval,
  toGstParts,
  type Interval,
} from "@/lib/time";
import type { AvailabilityQuery, TimeSlot } from "./provider";

/**
 * The rules that decide which times may be offered, in one place.
 *
 * Working hours, the slot grid, the buffer either side of a session, the
 * minimum notice and the booking horizon are OUR rules, and they apply
 * whatever calendar sits behind the port. The calendar contributes one thing:
 * the times that are already taken. So the rules live here, take the busy
 * times as an input, and both providers - the in-memory one and the real one
 * - call the same functions. Two copies of this logic would be two places for
 * a customer to be offered a time nobody intends to be available.
 *
 * Every instant is UTC. The rules are written in Gulf Standard Time, which
 * has no daylight saving, so a window that says 18:00 means the same instant
 * every day of the year.
 */

/**
 * Every slot the rules would offer inside the query window, given what is
 * already on the calendar.
 */
export function candidateSlots(
  query: AvailabilityQuery,
  rules: AvailabilityRules,
  now: Date,
  busy: readonly Interval[],
): TimeSlot[] {
  if (query.durationMinutes <= 0) return [];

  const earliest = maxDate(query.from, addMinutes(now, rules.minimumNoticeHours * 60));
  const latest = minDate(query.to, addDays(now, rules.bookingHorizonDays));
  if (earliest.getTime() >= latest.getTime()) return [];

  const slots: TimeSlot[] = [];
  let day = gstDayStartUtc(earliest);

  while (day.getTime() <= latest.getTime()) {
    const weekday = toGstParts(day).weekday;
    for (const window of windowsForWeekday(rules, weekday)) {
      for (
        let minutes = window.startMinutes;
        minutes + query.durationMinutes <= window.endMinutes;
        minutes += rules.slotIntervalMinutes
      ) {
        const start = gstTimeOnDayUtc(day, minutes);
        const slot = { start, end: addMinutes(start, query.durationMinutes) };
        if (start.getTime() < earliest.getTime()) continue;
        if (slot.end.getTime() > latest.getTime()) continue;
        if (conflictsWithBusy(slot, busy, rules.bufferMinutes)) continue;
        slots.push(slot);
      }
    }
    day = addDays(day, 1);
  }

  return slots;
}

/**
 * Whether one specific slot is one the rules would offer right now.
 *
 * Re-validated at the moment of holding rather than trusted from whatever a
 * browser sent. The slot must be one we would actually have offered, not
 * merely one that happens to be free - otherwise a request can book 3am, or
 * a time inside the notice period, simply by asking for it.
 */
export function isBookableSlot(
  slot: TimeSlot,
  rules: AvailabilityRules,
  now: Date,
  busy: readonly Interval[],
): boolean {
  const durationMinutes = (slot.end.getTime() - slot.start.getTime()) / 60_000;
  if (durationMinutes <= 0) return false;

  if (slot.start.getTime() < addMinutes(now, rules.minimumNoticeHours * 60).getTime()) {
    return false;
  }
  if (slot.start.getTime() > addDays(now, rules.bookingHorizonDays).getTime()) {
    return false;
  }

  const parts = toGstParts(slot.start);
  const fitsAWindow = windowsForWeekday(rules, parts.weekday).some((window) => {
    const startsInWindow = parts.minutesOfDay >= window.startMinutes;
    const endsInWindow = parts.minutesOfDay + durationMinutes <= window.endMinutes;
    const offset = parts.minutesOfDay - window.startMinutes;
    const alignedToInterval = offset % rules.slotIntervalMinutes === 0;
    return startsInWindow && endsInWindow && alignedToInterval;
  });

  return fitsAWindow && !conflictsWithBusy(slot, busy, rules.bufferMinutes);
}

/** A slot conflicts if it lands within the buffer around anything already taken. */
export function conflictsWithBusy(
  slot: TimeSlot,
  busy: readonly Interval[],
  bufferMinutes: number,
): boolean {
  for (const taken of busy) {
    if (intervalsOverlap(slot, padInterval(taken, bufferMinutes))) return true;
  }
  return false;
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}
