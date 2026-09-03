import { AVAILABILITY, type AvailabilityRules } from "@/config/availability";
import { GraphClient, GraphNotFoundError } from "@/lib/microsoft-graph";
import { addMinutes, type Interval } from "@/lib/time";
import {
  EventNotFoundError,
  SchedulingError,
  SlotUnavailableError,
  type AvailabilityQuery,
  type ConfirmSlotInput,
  type ExternalEvent,
  type HoldSlotInput,
  type SchedulingProvider,
  type TimeSlot,
} from "./provider";
import { candidateSlots, isBookableSlot } from "./rules";

/**
 * The real calendar: one Microsoft 365 mailbox, through Graph.
 *
 * The rules - hours, grid, buffer, notice, horizon - are the shared ones in
 * ./rules. This provider contributes only what the calendar knows: the times
 * already taken, read fresh from the calendar view every time they matter.
 * That includes the founder's own appointments, which is the whole reason a
 * real provider exists: a personal commitment must take a slot off sale.
 *
 * The sequence follows the port. A hold is a TENTATIVE event with no
 * attendee, so nothing is emailed to anybody before payment. Confirmation
 * patches it to busy, switches on the Teams meeting, and adds the customer -
 * which is what makes Outlook send the invitation carrying the join link.
 * Release deletes; cancel uses the calendar's own cancel action, so an
 * invited customer is told.
 *
 * Every time sent to Graph is UTC, and every time read back is asked for in
 * UTC, so no offset arithmetic happens here at all.
 */

export interface GraphSchedulingProviderOptions {
  readonly client: GraphClient;
  /** The mailbox whose calendar is the diary: an address or a directory object id. */
  readonly mailbox: string;
  readonly rules?: AvailabilityRules;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface GraphDateTime {
  readonly dateTime: string;
  readonly timeZone: string;
}

interface GraphEvent {
  readonly id: string;
  readonly start: GraphDateTime;
  readonly end: GraphDateTime;
  readonly showAs?: string;
  readonly isCancelled?: boolean;
  readonly isOnlineMeeting?: boolean;
  readonly onlineMeeting?: { readonly joinUrl?: string | null } | null;
}

const EVENT_FIELDS = "id,start,end,showAs,isCancelled,isOnlineMeeting,onlineMeeting";
const VIEW_FIELDS = "id,start,end,showAs,isCancelled";
/** Ask for UTC back, so what we parse is what we sent. */
const PREFER_UTC = { Prefer: 'outlook.timezone="UTC"' };
/** What counts as taken. `free` is a calendar entry that deliberately does not block. */
const BLOCKING = new Set(["busy", "tentative", "oof", "workingElsewhere"]);
/** Teams provisions the join link a moment after the event is switched to an online meeting. */
const JOIN_LINK_ATTEMPTS = 4;
const JOIN_LINK_WAIT_MS = 1_500;

export class GraphSchedulingProvider implements SchedulingProvider {
  private readonly client: GraphClient;
  private readonly mailbox: string;
  private readonly rules: AvailabilityRules;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: GraphSchedulingProviderOptions) {
    this.client = options.client;
    this.mailbox = options.mailbox;
    this.rules = options.rules ?? AVAILABILITY;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async listAvailability(query: AvailabilityQuery): Promise<readonly TimeSlot[]> {
    if (query.durationMinutes <= 0) return [];
    const busy = await this.busyBetween(query.from, query.to);
    return candidateSlots(query, this.rules, this.now(), busy);
  }

  async holdSlot(input: HoldSlotInput): Promise<ExternalEvent> {
    /*
      A fresh look at the calendar around this slot, at the moment of holding.
      The window is the slot plus the buffer either side, because anything
      inside the buffer counts as a conflict. Whatever the customer was shown
      earlier is not trusted - the founder may have added something since.
    */
    const around = {
      start: addMinutes(input.slot.start, -this.rules.bufferMinutes),
      end: addMinutes(input.slot.end, this.rules.bufferMinutes),
    };
    const busy = await this.busyBetween(around.start, around.end);
    if (!isBookableSlot(input.slot, this.rules, this.now(), busy)) {
      throw new SlotUnavailableError(input.slot);
    }

    const response = await this.client.request<GraphEvent>({
      method: "POST",
      path: this.path("/events"),
      headers: PREFER_UTC,
      body: {
        subject: input.subject,
        body: {
          contentType: "text",
          content: `Held for ${input.attendeeName} while they complete payment. Released automatically if payment does not complete.`,
        },
        start: graphTime(input.slot.start),
        end: graphTime(input.slot.end),
        showAs: "tentative",
        isReminderOn: false,
        // No attendees: an attendee is invited, and nobody is invited before they have paid.
        ...(input.holdReference ? { transactionId: input.holdReference } : {}),
      },
    });

    return toExternalEvent(required(response.body, "create event"));
  }

  async confirmSlot(externalId: string, attendee: ConfirmSlotInput): Promise<ExternalEvent> {
    const current = await this.readEvent(externalId);
    if (current === null) throw new EventNotFoundError(externalId);
    if (current.isCancelled) throw new SlotUnavailableError(slotOf(current));

    // Already done: the webhook that asks for this retries, and a second
    // confirmation must not re-invite or re-provision anything.
    const already = toExternalEvent(current);
    if (already.status === "confirmed" && already.meetingUrl !== null) return already;

    await this.client.request({
      method: "PATCH",
      path: this.eventPath(externalId),
      headers: PREFER_UTC,
      body: {
        showAs: "busy",
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
        isReminderOn: true,
        reminderMinutesBeforeStart: 15,
        attendees: [
          {
            emailAddress: { address: attendee.attendeeEmail, name: attendee.attendeeName },
            type: "required",
          },
        ],
        body: {
          contentType: "text",
          content: "Your private session. Join with the Teams link in this invitation.",
        },
      },
    });

    /*
      The join link is issued by Teams, not by the patch, and it can arrive a
      moment later. A confirmation without a link is worse than a failed one -
      the customer would be told they have a session with nowhere to join it -
      so this waits briefly and then fails loudly for the caller to retry.
    */
    for (let attempt = 1; attempt <= JOIN_LINK_ATTEMPTS; attempt += 1) {
      const fresh = await this.readEvent(externalId);
      if (fresh === null) throw new EventNotFoundError(externalId);
      const event = toExternalEvent(fresh);
      if (event.meetingUrl !== null) return event;
      if (attempt < JOIN_LINK_ATTEMPTS) await this.sleep(JOIN_LINK_WAIT_MS);
    }
    throw new SchedulingError(
      `The calendar confirmed event ${externalId} but has not issued its meeting link yet`,
    );
  }

  async releaseSlot(externalId: string): Promise<void> {
    try {
      await this.client.request({ method: "DELETE", path: this.eventPath(externalId) });
    } catch (error) {
      // Already gone is the state we wanted. Cleanup that throws on a clean
      // state blocks the sweep behind it.
      if (error instanceof GraphNotFoundError) return;
      throw error;
    }
  }

  async cancelEvent(externalId: string): Promise<void> {
    try {
      // The calendar's own cancel, not a delete: the invited customer is told.
      await this.client.request({
        method: "POST",
        path: this.eventPath(`${externalId}/cancel`),
        body: { comment: "This session has been cancelled." },
      });
    } catch (error) {
      if (error instanceof GraphNotFoundError) throw new EventNotFoundError(externalId);
      throw error;
    }
  }

  async getEvent(externalId: string): Promise<ExternalEvent | null> {
    const event = await this.readEvent(externalId);
    return event === null ? null : toExternalEvent(event);
  }

  /** Everything that blocks time in the window, as plain intervals. */
  private async busyBetween(from: Date, to: Date): Promise<Interval[]> {
    const events = await this.client.list<GraphEvent>({
      path: this.path("/calendarView"),
      query: {
        startDateTime: from.toISOString(),
        endDateTime: to.toISOString(),
        $select: VIEW_FIELDS,
        $top: "200",
      },
      headers: PREFER_UTC,
    });

    return events
      .filter((event) => !event.isCancelled && BLOCKING.has(event.showAs ?? "busy"))
      .map((event) => ({ start: parseGraphTime(event.start), end: parseGraphTime(event.end) }));
  }

  private async readEvent(externalId: string): Promise<GraphEvent | null> {
    try {
      const response = await this.client.request<GraphEvent>({
        method: "GET",
        path: this.eventPath(externalId),
        query: { $select: EVENT_FIELDS },
        headers: PREFER_UTC,
      });
      return required(response.body, "read event");
    } catch (error) {
      if (error instanceof GraphNotFoundError) return null;
      throw error;
    }
  }

  private path(suffix: string): string {
    return `/users/${encodeURIComponent(this.mailbox)}${suffix}`;
  }

  private eventPath(idAndSuffix: string): string {
    const [id, ...rest] = idAndSuffix.split("/");
    return this.path(
      `/events/${encodeURIComponent(id ?? "")}${rest.length ? `/${rest.join("/")}` : ""}`,
    );
  }
}

/** An instant as Graph wants it: local-looking text plus an explicit zone, and the zone is always UTC. */
function graphTime(instant: Date): GraphDateTime {
  return { dateTime: instant.toISOString().replace(/\.\d{3}Z$/, ""), timeZone: "UTC" };
}

/**
 * Graph answers with seven fractional digits and no offset, in whatever zone
 * the Prefer header asked for. We always ask for UTC, and refuse anything
 * else rather than guess - a wrong offset here is a customer at the wrong
 * hour.
 */
function parseGraphTime(value: GraphDateTime): Date {
  if (value.timeZone !== "UTC") {
    throw new SchedulingError(
      `Expected a UTC time from the calendar, got zone "${value.timeZone}"`,
    );
  }
  const trimmed = value.dateTime.replace(/Z$/, "").replace(/(\.\d{3})\d+$/, "$1");
  const parsed = new Date(`${trimmed}Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new SchedulingError(`Unreadable time from the calendar: "${value.dateTime}"`);
  }
  return parsed;
}

function slotOf(event: GraphEvent): TimeSlot {
  return { start: parseGraphTime(event.start), end: parseGraphTime(event.end) };
}

function toExternalEvent(event: GraphEvent): ExternalEvent {
  const status = event.isCancelled
    ? "cancelled"
    : event.showAs === "tentative"
      ? "tentative"
      : "confirmed";
  const joinUrl = event.onlineMeeting?.joinUrl ?? null;
  return {
    externalId: event.id,
    status,
    start: parseGraphTime(event.start),
    end: parseGraphTime(event.end),
    // A link on a tentative or cancelled event is not something to hand out.
    meetingUrl: status === "confirmed" ? joinUrl : null,
  };
}

function required<T>(body: T | null, what: string): T {
  if (body === null) throw new SchedulingError(`The calendar answered "${what}" with no body`);
  return body;
}
