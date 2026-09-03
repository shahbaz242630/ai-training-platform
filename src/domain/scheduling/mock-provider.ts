import { AVAILABILITY, type AvailabilityRules } from "@/config/availability";
import type { Interval } from "@/lib/time";
import {
  EventNotFoundError,
  SlotUnavailableError,
  type AvailabilityQuery,
  type ExternalEvent,
  type HoldSlotInput,
  type SchedulingProvider,
  type TimeSlot,
} from "./provider";
import { candidateSlots, isBookableSlot } from "./rules";

/**
 * An in-memory scheduling provider.
 *
 * This is not a stub that returns canned answers. It applies the same rules
 * the real calendar has to apply - working hours, buffers, notice, horizon,
 * and conflicts against events already on the calendar - through the same
 * functions the real provider uses. Only the source of "what is already
 * taken" differs: here it is a map in memory, there it is the calendar.
 * Everything downstream of scheduling can be built and tested before a
 * Microsoft tenant is involved at all.
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
    return Promise.resolve(candidateSlots(query, this.rules, this.now(), this.busy()));
  }

  holdSlot(input: HoldSlotInput): Promise<ExternalEvent> {
    if (!isBookableSlot(input.slot, this.rules, this.now(), this.busy())) {
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

  /** What is already taken: every live event. A cancelled one frees its time. */
  private busy(): Interval[] {
    const taken: Interval[] = [];
    for (const event of this.events.values()) {
      if (event.status === "cancelled") continue;
      taken.push({ start: event.start, end: event.end });
    }
    return taken;
  }
}
