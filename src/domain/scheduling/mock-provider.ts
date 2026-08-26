import { AVAILABILITY, windowsForWeekday, type AvailabilityRules } from "@/config/availability";
import {
  addDays,
  addMinutes,
  gstDayStartUtc,
  gstTimeOnDayUtc,
  intervalsOverlap,
  padInterval,
  toGstParts,
} from "@/lib/time";
import {
  EventNotFoundError,
  SlotUnavailableError,
  type AvailabilityQuery,
  type ExternalEvent,
  type HoldSlotInput,
  type SchedulingProvider,
  type TimeSlot,
} from "./provider";

/**
 * An in-memory scheduling provider.
 *
 * This is not a stub that returns canned answers. It applies the same rules
 * the real calendar has to apply - working hours, buffers, notice, horizon,
 * and conflicts against events already on the calendar - so a booking flow
 * that works against this one is exercising real logic rather than a
 * pass-through. Everything downstream of scheduling can be built and tested
 * before a Microsoft tenant is involved at all.
 *
 * It is also the only implementation that can run in a test: the real one
 * needs a tenant, a licence and a secret.
 *
 * Both the clock and the id generator are injected, so a test controls time
 * instead of waiting for it and gets the same ids on every run.
 */

export interface MockSchedulingProviderOptions {
  /** Injected so tests control time. Defaults to the real clock. */
  readonly now?: () => Date;
  readonly rules?: AvailabilityRules;
  /** Events already on the calendar - other bookings, or the founder's own commitments. */
  readonly seedEvents?: readonly ExternalEvent[];
  readonly idPrefix?: string;
}

export class MockSchedulingProvider implements SchedulingProvider {
  private readonly now: () => Date;
  private readonly rules: AvailabilityRules;
  private readonly events = new Map<string, ExternalEvent>();
  private readonly idPrefix: string;
  private nextId = 1;

  constructor(options: MockSchedulingProviderOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.rules = options.rules ?? AVAILABILITY;
    this.idPrefix = options.idPrefix ?? "mock_evt";
    for (const event of options.seedEvents ?? []) {
      this.events.set(event.externalId, event);
    }
  }

  listAvailability(query: AvailabilityQuery): Promise<readonly TimeSlot[]> {
    if (query.durationMinutes <= 0) return Promise.resolve([]);

    const now = this.now();
    const earliest = maxDate(query.from, addMinutes(now, this.rules.minimumNoticeHours * 60));
    const latest = minDate(query.to, addDays(now, this.rules.bookingHorizonDays));
    if (earliest.getTime() >= latest.getTime()) return Promise.resolve([]);

    const slots: TimeSlot[] = [];
    let day = gstDayStartUtc(earliest);

    while (day.getTime() <= latest.getTime()) {
      const weekday = toGstParts(day).weekday;
      for (const window of windowsForWeekday(this.rules, weekday)) {
        for (
          let minutes = window.startMinutes;
          minutes + query.durationMinutes <= window.endMinutes;
          minutes += this.rules.slotIntervalMinutes
        ) {
          const start = gstTimeOnDayUtc(day, minutes);
          const slot = { start, end: addMinutes(start, query.durationMinutes) };
          if (start.getTime() < earliest.getTime()) continue;
          if (slot.end.getTime() > latest.getTime()) continue;
          if (this.conflictsWithCalendar(slot)) continue;
          slots.push(slot);
        }
      }
      day = addDays(day, 1);
    }

    return Promise.resolve(slots);
  }

  holdSlot(input: HoldSlotInput): Promise<ExternalEvent> {
    // Re-validated here rather than trusted from whatever the browser sent.
    // The slot must be one this provider would actually have offered, not just
    // one that happens to be free - otherwise a request can book 3am, or a
    // time inside the notice period, simply by asking for it.
    if (!this.isBookable(input.slot)) {
      return Promise.reject(new SlotUnavailableError(input.slot));
    }

    const event: ExternalEvent = {
      externalId: `${this.idPrefix}_${this.nextId++}`,
      status: "tentative",
      start: input.slot.start,
      end: input.slot.end,
      meetingUrl: null,
    };
    this.events.set(event.externalId, event);
    return Promise.resolve(event);
  }

  confirmSlot(externalId: string): Promise<ExternalEvent> {
    const event = this.events.get(externalId);
    if (!event) return Promise.reject(new EventNotFoundError(externalId));

    // Confirming an already confirmed event is a no-op, not an error: the
    // webhook that triggers it is retried.
    if (event.status === "confirmed") return Promise.resolve(event);
    if (event.status === "cancelled") {
      return Promise.reject(new SlotUnavailableError({ start: event.start, end: event.end }));
    }

    const confirmed: ExternalEvent = {
      ...event,
      status: "confirmed",
      meetingUrl: `https://teams.mock.invalid/meet/${externalId}`,
    };
    this.events.set(externalId, confirmed);
    return Promise.resolve(confirmed);
  }

  releaseSlot(externalId: string): Promise<void> {
    // Silent on a missing event by design. Releasing runs in a sweep that can
    // retry, and cleanup that throws on an already-clean state blocks
    // everything queued behind it.
    this.events.delete(externalId);
    return Promise.resolve();
  }

  cancelEvent(externalId: string): Promise<void> {
    const event = this.events.get(externalId);
    // Unlike releasing, this one throws: a confirmed session that has vanished
    // from the calendar is a real problem, and swallowing it means a customer
    // is never told their session was cancelled.
    if (!event) return Promise.reject(new EventNotFoundError(externalId));
    this.events.set(externalId, { ...event, status: "cancelled", meetingUrl: null });
    return Promise.resolve();
  }

  getEvent(externalId: string): Promise<ExternalEvent | null> {
    return Promise.resolve(this.events.get(externalId) ?? null);
  }

  /** Test and development helper. Not part of the port. */
  listEvents(): readonly ExternalEvent[] {
    return [...this.events.values()];
  }

  private isBookable(slot: TimeSlot): boolean {
    const durationMinutes = (slot.end.getTime() - slot.start.getTime()) / 60_000;
    if (durationMinutes <= 0) return false;

    const now = this.now();
    if (slot.start.getTime() < addMinutes(now, this.rules.minimumNoticeHours * 60).getTime()) {
      return false;
    }
    if (slot.start.getTime() > addDays(now, this.rules.bookingHorizonDays).getTime()) {
      return false;
    }

    const parts = toGstParts(slot.start);
    const fitsAWindow = windowsForWeekday(this.rules, parts.weekday).some((window) => {
      const startsInWindow = parts.minutesOfDay >= window.startMinutes;
      const endsInWindow = parts.minutesOfDay + durationMinutes <= window.endMinutes;
      const offset = parts.minutesOfDay - window.startMinutes;
      const alignedToInterval = offset % this.rules.slotIntervalMinutes === 0;
      return startsInWindow && endsInWindow && alignedToInterval;
    });

    return fitsAWindow && !this.conflictsWithCalendar(slot);
  }

  /** A slot conflicts if it lands within the buffer around any live event. */
  private conflictsWithCalendar(slot: TimeSlot): boolean {
    for (const event of this.events.values()) {
      if (event.status === "cancelled") continue;
      const blocked = padInterval({ start: event.start, end: event.end }, this.rules.bufferMinutes);
      if (intervalsOverlap(slot, blocked)) return true;
    }
    return false;
  }
}

function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}
