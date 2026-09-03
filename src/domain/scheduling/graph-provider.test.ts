import { describe, expect, it, vi } from "vitest";
import type { AvailabilityRules } from "@/config/availability";
import { GraphClient } from "@/lib/microsoft-graph";
import { addDays, at, type Weekday } from "@/lib/time";
import { GraphSchedulingProvider } from "./graph-provider";
import { EventNotFoundError, SchedulingError, SlotUnavailableError } from "./provider";

/**
 * The real provider against a scripted Graph. Every request it makes is
 * asserted - the path, the query, the headers, the body - because the first
 * live call against the tenant should have nothing left to prove about what
 * we send, only about what Microsoft answers.
 */

const MONDAY: Weekday = 1;
const SATURDAY: Weekday = 6;

const RULES: AvailabilityRules = {
  windows: [
    { weekday: MONDAY, startMinutes: at(18), endMinutes: at(21) },
    { weekday: SATURDAY, startMinutes: at(10), endMinutes: at(13) },
  ],
  slotIntervalMinutes: 30,
  bufferMinutes: 15,
  minimumNoticeHours: 24,
  bookingHorizonDays: 30,
};

/** Monday 7 September 2026, 10:00 in Dubai. */
const NOW = new Date("2026-09-07T06:00:00.000Z");
/** Saturday 12 September, 10:00 in Dubai. */
const SATURDAY_10 = {
  start: new Date("2026-09-12T06:00:00.000Z"),
  end: new Date("2026-09-12T07:30:00.000Z"),
};
const MAILBOX = "booking@example.com";
const ATTENDEE = { attendeeName: "Amina Khan", attendeeEmail: "amina@example.com" };

type Scripted = { status: number; body?: unknown; headers?: Record<string, string> };
type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

function scripted(answers: Scripted[]) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? "GET",
      url: String(url),
      headers: (init?.headers as Record<string, string>) ?? {},
      body:
        typeof init?.body === "string" && init.body.startsWith("{")
          ? JSON.parse(init.body)
          : init?.body,
    });
    const next = answers.shift();
    if (!next)
      throw new Error(`scripted graph ran out of answers at ${init?.method} ${String(url)}`);
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json", ...next.headers },
    });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const token = { status: 200, body: { access_token: "tok", expires_in: 3600 } };
const sleeps: number[] = [];

function provider(answers: Scripted[]) {
  const { fetchImpl, calls } = scripted([token, ...answers]);
  const client = new GraphClient({
    credentials: { tenantId: "t", clientId: "c", clientSecret: "s" },
    fetch: fetchImpl,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const graph = new GraphSchedulingProvider({
    client,
    mailbox: MAILBOX,
    rules: RULES,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  /** Graph calls only - the token request is the first one and not interesting here. */
  const graphCalls = () => calls.slice(1);
  return { graph, graphCalls };
}

/** An event as Graph returns it: seven fractional digits, no offset, the zone we asked for. */
function graphEvent(input: {
  id?: string;
  start?: Date;
  end?: Date;
  showAs?: string;
  isCancelled?: boolean;
  joinUrl?: string | null;
}) {
  const fmt = (d: Date) => ({ dateTime: d.toISOString().replace("Z", "0000"), timeZone: "UTC" });
  return {
    id: input.id ?? "evt_1",
    start: fmt(input.start ?? SATURDAY_10.start),
    end: fmt(input.end ?? SATURDAY_10.end),
    showAs: input.showAs ?? "tentative",
    isCancelled: input.isCancelled ?? false,
    isOnlineMeeting: input.joinUrl != null,
    onlineMeeting: input.joinUrl === undefined ? null : { joinUrl: input.joinUrl },
  };
}

const view = (events: unknown[], nextLink?: string) => ({
  status: 200,
  body: { value: events, ...(nextLink ? { "@odata.nextLink": nextLink } : {}) },
});

const has = (slots: readonly { start: Date }[], start: Date) =>
  slots.some((s) => s.start.getTime() === start.getTime());

describe("listAvailability", () => {
  it("reads the calendar view for the window in UTC and takes busy times off the grid", async () => {
    const { graph, graphCalls } = provider([view([graphEvent({ showAs: "busy" })])]);

    const slots = await graph.listAvailability({
      from: NOW,
      to: addDays(NOW, 10),
      durationMinutes: 90,
    });

    const [call] = graphCalls();
    expect(call?.method).toBe("GET");
    expect(call?.url).toContain(`/users/${encodeURIComponent(MAILBOX)}/calendarView?`);
    expect(call?.url).toContain("startDateTime=2026-09-07T06%3A00%3A00.000Z");
    expect(call?.url).toContain("endDateTime=2026-09-17T06%3A00%3A00.000Z");
    expect(call?.url).toContain("%24select=id%2Cstart%2Cend%2CshowAs%2CisCancelled");
    expect(call?.headers.Prefer).toBe('outlook.timezone="UTC"');
    expect(has(slots, SATURDAY_10.start)).toBe(false);
    expect(slots.length).toBeGreaterThan(0);
  });

  it("ignores a cancelled entry and one marked free", async () => {
    const { graph } = provider([
      view([graphEvent({ isCancelled: true }), graphEvent({ id: "evt_2", showAs: "free" })]),
    ]);
    const slots = await graph.listAvailability({
      from: NOW,
      to: addDays(NOW, 10),
      durationMinutes: 90,
    });
    expect(has(slots, SATURDAY_10.start)).toBe(true);
  });

  it("treats tentative, out of office and working elsewhere as taken", async () => {
    for (const showAs of ["tentative", "oof", "workingElsewhere"]) {
      const { graph } = provider([view([graphEvent({ showAs })])]);
      const slots = await graph.listAvailability({
        from: NOW,
        to: addDays(NOW, 10),
        durationMinutes: 90,
      });
      expect(has(slots, SATURDAY_10.start), showAs).toBe(false);
    }
  });

  it("follows the next link, so a busy diary is read in full", async () => {
    const { graph, graphCalls } = provider([
      view([], "https://graph.microsoft.com/v1.0/users/x/calendarView?$skip=1"),
      view([graphEvent({ showAs: "busy" })]),
    ]);
    const slots = await graph.listAvailability({
      from: NOW,
      to: addDays(NOW, 10),
      durationMinutes: 90,
    });
    expect(graphCalls()).toHaveLength(2);
    expect(has(slots, SATURDAY_10.start)).toBe(false);
  });

  it("refuses a time that came back in any zone but UTC, rather than guessing the offset", async () => {
    const wrongZone = {
      ...graphEvent({}),
      start: { dateTime: "2026-09-12T10:00:00.0000000", timeZone: "Arabian Standard Time" },
    };
    const { graph } = provider([view([wrongZone])]);
    await expect(
      graph.listAvailability({ from: NOW, to: addDays(NOW, 10), durationMinutes: 90 }),
    ).rejects.toThrow(SchedulingError);
  });
});

describe("holdSlot", () => {
  const input = {
    slot: SATURDAY_10,
    subject: "Claude, Claude Code & Advanced Workflows",
    attendeeName: "Amina Khan",
    attendeeEmail: "amina@example.com",
    holdReference: "hold_abc",
  };

  it("re-reads the calendar around the slot, then creates a tentative event with no attendee", async () => {
    const { graph, graphCalls } = provider([view([]), { status: 201, body: graphEvent({}) }]);

    const held = await graph.holdSlot(input);

    const [check, create] = graphCalls();
    expect(check?.url).toContain("startDateTime=2026-09-12T05%3A45%3A00.000Z");
    expect(check?.url).toContain("endDateTime=2026-09-12T07%3A45%3A00.000Z");
    expect(create?.method).toBe("POST");
    expect(create?.url).toBe(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/events`,
    );
    expect(create?.body).toMatchObject({
      subject: "Claude, Claude Code & Advanced Workflows",
      start: { dateTime: "2026-09-12T06:00:00", timeZone: "UTC" },
      end: { dateTime: "2026-09-12T07:30:00", timeZone: "UTC" },
      showAs: "tentative",
      isReminderOn: false,
      transactionId: "hold_abc",
    });
    expect(create?.body).not.toHaveProperty("attendees");
    expect(held).toEqual({
      externalId: "evt_1",
      status: "tentative",
      start: SATURDAY_10.start,
      end: SATURDAY_10.end,
      meetingUrl: null,
    });
  });

  it("refuses when the calendar now shows a conflict, and creates nothing", async () => {
    const { graph, graphCalls } = provider([view([graphEvent({ showAs: "busy" })])]);
    await expect(graph.holdSlot(input)).rejects.toBeInstanceOf(SlotUnavailableError);
    expect(graphCalls()).toHaveLength(1);
  });

  it("refuses a slot the rules would never offer, however empty the calendar", async () => {
    const { graph, graphCalls } = provider([view([])]);
    const threeAm = {
      start: new Date("2026-09-12T23:00:00Z"),
      end: new Date("2026-09-13T00:30:00Z"),
    };
    await expect(graph.holdSlot({ ...input, slot: threeAm })).rejects.toBeInstanceOf(
      SlotUnavailableError,
    );
    expect(graphCalls().filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("confirmSlot", () => {
  it("promotes the event, invites the attendee, switches on Teams, and returns the join link", async () => {
    sleeps.length = 0;
    const { graph, graphCalls } = provider([
      { status: 200, body: graphEvent({}) },
      {
        status: 200,
        body: graphEvent({ showAs: "busy", joinUrl: "https://teams.microsoft.com/l/x" }),
      },
      {
        status: 200,
        body: graphEvent({ showAs: "busy", joinUrl: "https://teams.microsoft.com/l/x" }),
      },
    ]);

    const confirmed = await graph.confirmSlot("evt_1", ATTENDEE);

    const [, patch] = graphCalls();
    expect(patch?.method).toBe("PATCH");
    expect(patch?.url).toBe(
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/events/evt_1`,
    );
    expect(patch?.body).toMatchObject({
      showAs: "busy",
      isOnlineMeeting: true,
      onlineMeetingProvider: "teamsForBusiness",
      attendees: [
        { emailAddress: { address: "amina@example.com", name: "Amina Khan" }, type: "required" },
      ],
    });
    expect(confirmed).toMatchObject({
      status: "confirmed",
      meetingUrl: "https://teams.microsoft.com/l/x",
    });
    expect(sleeps).toEqual([]);
  });

  it("waits briefly for a join link that lags the patch", async () => {
    sleeps.length = 0;
    const { graph } = provider([
      { status: 200, body: graphEvent({}) },
      { status: 200, body: graphEvent({ showAs: "busy" }) },
      { status: 200, body: graphEvent({ showAs: "busy", joinUrl: null }) },
      {
        status: 200,
        body: graphEvent({ showAs: "busy", joinUrl: "https://teams.microsoft.com/l/y" }),
      },
    ]);

    const confirmed = await graph.confirmSlot("evt_1", ATTENDEE);

    expect(confirmed.meetingUrl).toBe("https://teams.microsoft.com/l/y");
    expect(sleeps).toEqual([1500]);
  });

  it("fails loudly, for a retry later, when no link ever arrives", async () => {
    sleeps.length = 0;
    const busyNoLink = { status: 200, body: graphEvent({ showAs: "busy", joinUrl: null }) };
    const { graph } = provider([
      { status: 200, body: graphEvent({}) },
      { status: 200, body: {} },
      busyNoLink,
      busyNoLink,
      busyNoLink,
      busyNoLink,
    ]);

    await expect(graph.confirmSlot("evt_1", ATTENDEE)).rejects.toThrow(
      /has not issued its meeting link/,
    );
    expect(sleeps).toEqual([1500, 1500, 1500]);
  });

  it("is a no-op for an event already confirmed with a link, so a retried webhook re-invites nobody", async () => {
    const { graph, graphCalls } = provider([
      {
        status: 200,
        body: graphEvent({ showAs: "busy", joinUrl: "https://teams.microsoft.com/l/z" }),
      },
    ]);
    const confirmed = await graph.confirmSlot("evt_1", ATTENDEE);
    expect(confirmed.meetingUrl).toBe("https://teams.microsoft.com/l/z");
    expect(graphCalls().filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("refuses an event that is gone, and one that was cancelled", async () => {
    const gone = provider([
      { status: 404, body: { error: { code: "ErrorItemNotFound", message: "no" } } },
    ]);
    await expect(gone.graph.confirmSlot("evt_x", ATTENDEE)).rejects.toBeInstanceOf(
      EventNotFoundError,
    );

    const cancelled = provider([{ status: 200, body: graphEvent({ isCancelled: true }) }]);
    await expect(cancelled.graph.confirmSlot("evt_1", ATTENDEE)).rejects.toBeInstanceOf(
      SlotUnavailableError,
    );
  });
});

describe("releaseSlot, cancelEvent and getEvent", () => {
  it("deletes a hold, and says nothing when it is already gone", async () => {
    const { graph, graphCalls } = provider([
      { status: 204 },
      { status: 404, body: { error: { code: "ErrorItemNotFound", message: "no" } } },
    ]);
    await graph.releaseSlot("evt_1");
    await graph.releaseSlot("evt_1");
    expect(graphCalls().map((c) => c.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("cancels through the calendar's own action so the attendee is told, and refuses a missing event", async () => {
    const { graph, graphCalls } = provider([
      { status: 202 },
      { status: 404, body: { error: { code: "ErrorItemNotFound", message: "no" } } },
    ]);
    await graph.cancelEvent("evt_1");
    expect(graphCalls()[0]).toMatchObject({
      method: "POST",
      url: `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MAILBOX)}/events/evt_1/cancel`,
    });
    await expect(graph.cancelEvent("evt_gone")).rejects.toBeInstanceOf(EventNotFoundError);
  });

  it("reads an event back, hands out a link only once confirmed, and is null when there is none", async () => {
    const { graph } = provider([
      { status: 200, body: graphEvent({ showAs: "tentative", joinUrl: "https://early.example" }) },
      { status: 404, body: { error: { code: "ErrorItemNotFound", message: "no" } } },
    ]);
    expect(await graph.getEvent("evt_1")).toMatchObject({ status: "tentative", meetingUrl: null });
    expect(await graph.getEvent("evt_2")).toBeNull();
  });

  it("parses the seven fractional digits Graph sends", async () => {
    const { graph } = provider([
      {
        status: 200,
        body: {
          ...graphEvent({}),
          start: { dateTime: "2026-09-12T06:00:00.0000000", timeZone: "UTC" },
        },
      },
    ]);
    expect((await graph.getEvent("evt_1"))?.start).toEqual(SATURDAY_10.start);
  });
});
