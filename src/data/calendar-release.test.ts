import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findCustomerById } from "./customers";
import type { QueryRunner } from "./db";
import {
  attachCalendarEvent,
  claimHoldsAwaitingCalendarRelease,
  holdSlot,
  markCalendarReleased,
  releaseHoldById,
} from "./slot-holds";

/**
 * The bookkeeping that keeps a tentative calendar event from outliving its
 * hold. A leftover event blocks a slot on the real calendar, which
 * availability now reads, so this is the difference between a time being on
 * sale and not.
 */

const NOW = new Date("2026-10-01T09:00:00Z");
let db: PGlite;
let runner: QueryRunner;

beforeAll(async () => {
  db = await PGlite.create();
  const applySql = db.exec.bind(db);
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    await applySql(readFileSync(join(dir, file), "utf8"));
  }
  runner = db as unknown as QueryRunner;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

let counter = 0;
async function liveHold(expiresAt = new Date(NOW.getTime() + 35 * 60_000)) {
  counter += 1;
  const start = new Date(Date.UTC(2027, 5, 1, 10, 0) + counter * 3 * 60 * 60_000);
  const outcome = await holdSlot(
    { slotStart: start, slotEnd: new Date(start.getTime() + 90 * 60_000), expiresAt },
    (work) => work(runner),
  );
  if (!outcome.ok) throw new Error("setup could not hold");
  return outcome.hold.id;
}

describe("attachCalendarEvent", () => {
  it("attaches an event to a live hold", async () => {
    const id = await liveHold();
    expect(await attachCalendarEvent(runner, id, "evt_live")).toBe(true);
    const row = await db.query<{ calendar_event_id: string }>(
      "select calendar_event_id from slot_holds where id = $1",
      [id],
    );
    expect(row.rows[0]?.calendar_event_id).toBe("evt_live");
  });

  it("refuses a hold that is no longer live, so the caller removes the orphan", async () => {
    const id = await liveHold();
    await releaseHoldById(runner, id);
    expect(await attachCalendarEvent(runner, id, "evt_orphan")).toBe(false);
  });
});

describe("claimHoldsAwaitingCalendarRelease and markCalendarReleased", () => {
  it("claims released and expired holds that still have an event, and forgets them once marked", async () => {
    const released = await liveHold();
    await attachCalendarEvent(runner, released, "evt_released");
    await releaseHoldById(runner, released);

    const live = await liveHold();
    await attachCalendarEvent(runner, live, "evt_live_2");

    const noEvent = await liveHold();
    await releaseHoldById(runner, noEvent);

    const claimed = await claimHoldsAwaitingCalendarRelease(runner);

    expect(claimed.map((h) => h.id)).toContain(released);
    expect(claimed.map((h) => h.id)).not.toContain(live);
    expect(claimed.map((h) => h.id)).not.toContain(noEvent);

    await markCalendarReleased(runner, released, NOW);
    expect((await claimHoldsAwaitingCalendarRelease(runner)).map((h) => h.id)).not.toContain(
      released,
    );
  });

  it("never touches a converted hold: that event is the confirmed session", async () => {
    const id = await liveHold();
    await attachCalendarEvent(runner, id, "evt_converted");
    await db.query("update slot_holds set status = 'converted' where id = $1", [id]);
    expect((await claimHoldsAwaitingCalendarRelease(runner)).map((h) => h.id)).not.toContain(id);
  });
});

describe("findCustomerById", () => {
  it("returns the details a calendar invitation needs, and null for a stranger", async () => {
    const inserted = await db.query<{ id: string }>(
      `insert into customers (first_name, last_name, email, timezone)
       values ('Amina', 'Khan', 'find@example.com', 'Europe/London') returning id`,
    );
    const id = inserted.rows[0]?.id ?? "";
    expect(await findCustomerById(runner, id)).toEqual({
      id,
      firstName: "Amina",
      lastName: "Khan",
      email: "find@example.com",
      timezone: "Europe/London",
    });
    expect(await findCustomerById(runner, "00000000-0000-4000-8000-000000000000")).toBeNull();
  });
});
