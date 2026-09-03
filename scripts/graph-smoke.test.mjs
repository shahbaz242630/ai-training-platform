import { describe, expect, it } from "vitest";
import { AVAILABILITY } from "../src/config/availability";
import { GraphSchedulingProvider } from "../src/domain/scheduling/graph-provider";
import { GraphClient } from "../src/lib/microsoft-graph";
import { addDays } from "../src/lib/time";

/**
 * The real tenant, end to end. Skipped unless `pnpm graph:smoke` sets the
 * flag, so it costs CI nothing and cannot run by accident.
 *
 * What it proves, in order: the app-only token works; the calendar view can
 * be read; a tentative hold blocks a real slot; confirmation invites an
 * attendee and Teams issues a join link; the event reads back; cancel and
 * delete leave the calendar as it was. The attendee receives an invitation
 * and then a cancellation - use your own address.
 *
 * Every event it creates is titled so it can be recognised, and it deletes
 * what it made even when an assertion fails part way.
 */

const enabled = process.env.GRAPH_SMOKE === "1";

describe.skipIf(!enabled)("Microsoft Graph, against the real tenant", () => {
  it("reads availability, holds, confirms with a join link, and cleans up", async () => {
    const { MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, MS_CALENDAR_USER_ID } = process.env;
    expect(MS_TENANT_ID, "MS_TENANT_ID").toBeTruthy();
    expect(MS_CLIENT_ID, "MS_CLIENT_ID").toBeTruthy();
    expect(MS_CLIENT_SECRET, "MS_CLIENT_SECRET").toBeTruthy();
    expect(MS_CALENDAR_USER_ID, "MS_CALENDAR_USER_ID").toBeTruthy();

    const attendeeEmail = process.env.GRAPH_SMOKE_ATTENDEE ?? MS_CALENDAR_USER_ID;
    const client = new GraphClient({
      credentials: {
        tenantId: MS_TENANT_ID,
        clientId: MS_CLIENT_ID,
        clientSecret: MS_CLIENT_SECRET,
      },
    });
    const provider = new GraphSchedulingProvider({
      client,
      mailbox: MS_CALENDAR_USER_ID,
      rules: AVAILABILITY,
    });

    const now = new Date();
    const query = { from: now, to: addDays(now, 14), durationMinutes: 90 };

    const before = await provider.listAvailability(query);
    console.log(`availability: ${before.length} slots in the next 14 days`);
    expect(before.length).toBeGreaterThan(0);
    const slot = before[0];

    let externalId = null;
    try {
      const held = await provider.holdSlot({
        slot,
        subject: "SMOKE TEST - safe to delete",
        attendeeName: "Smoke Test",
        attendeeEmail,
        holdReference: `smoke-${Date.now()}`,
      });
      externalId = held.externalId;
      console.log(`held ${held.externalId} at ${held.start.toISOString()}`);
      expect(held.status).toBe("tentative");
      expect(held.meetingUrl).toBeNull();

      const during = await provider.listAvailability(query);
      expect(during.some((s) => s.start.getTime() === slot.start.getTime())).toBe(false);

      const confirmed = await provider.confirmSlot(held.externalId, {
        attendeeName: "Smoke Test",
        attendeeEmail,
      });
      console.log(`confirmed with join link: ${confirmed.meetingUrl}`);
      expect(confirmed.status).toBe("confirmed");
      expect(confirmed.meetingUrl).toMatch(/^https:\/\//);

      const read = await provider.getEvent(held.externalId);
      expect(read?.status).toBe("confirmed");

      await provider.cancelEvent(held.externalId);
    } finally {
      if (externalId) {
        await provider.releaseSlot(externalId);
        expect(await provider.getEvent(externalId)).toBeNull();
        console.log("cleaned up");
      }
    }
  }, 120_000);
});
