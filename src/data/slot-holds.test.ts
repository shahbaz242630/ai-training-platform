import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll } from "vitest";
import {
  claimExpiredHolds,
  holdSlot,
  isRetryableContention,
  isSlotTaken,
  listLiveHolds,
} from "./slot-holds";
import type { QueryRunner } from "./db";

/**
 * Recognising a lost race, in every shape Postgres actually reports it.
 *
 * These codes were MEASURED against the real database rather than assumed.
 * Racing real connections at one slot:
 *
 *   2, 3 and 8 contenders -> losers got 23P01, the exclusion violation
 *   25 contenders         -> losers got 40P01, DEADLOCK DETECTED
 *
 * Exactly one hold existed after every run. Code recognising only 23P01 would
 * show the right message under light contention and a generic failure under
 * heavy contention - exactly when a popular slot is being fought over.
 */

const pgError = (code: string, constraint?: string) =>
  Object.assign(new Error("postgres said no"), { code, constraint });

describe("isSlotTaken", () => {
  it("recognises the exclusion violation on our overlap constraint", () => {
    expect(isSlotTaken(pgError("23P01", "slot_holds_no_overlapping_live_hold"))).toBe(true);
  });

  it("recognises a unique violation", () => {
    expect(isSlotTaken(pgError("23505"))).toBe(true);
  });

  /*
    A future exclusion constraint on some other table must not be reported to
    a customer as "that time has gone" - that would hide a real fault behind a
    plausible message.
  */
  it("does not claim the slot is taken for an exclusion on a different constraint", () => {
    expect(isSlotTaken(pgError("23P01", "some_other_exclusion"))).toBe(false);
  });

  it("does not treat a deadlock as a verdict", () => {
    expect(isSlotTaken(pgError("40P01"))).toBe(false);
  });

  it("does not treat an ordinary failure as a lost race", () => {
    // Reporting a broken database as "that time has gone" sends a customer off
    // to pick another slot that will not work either.
    expect(isSlotTaken(pgError("42P01"))).toBe(false); // undefined_table
    expect(isSlotTaken(pgError("08006"))).toBe(false); // connection_failure
    expect(isSlotTaken(new Error("something else entirely"))).toBe(false);
    expect(isSlotTaken(null)).toBe(false);
    expect(isSlotTaken(undefined)).toBe(false);
    expect(isSlotTaken("a string")).toBe(false);
  });
});

describe("isRetryableContention", () => {
  // The one that only appeared at 25 contenders. Without it, the busiest slots
  // give the worst message.
  it("recognises a deadlock", () => {
    expect(isRetryableContention(pgError("40P01"))).toBe(true);
  });

  it("recognises a serialization failure", () => {
    expect(isRetryableContention(pgError("40001"))).toBe(true);
  });

  it("does not retry a definite loss", () => {
    expect(isRetryableContention(pgError("23P01", "slot_holds_no_overlapping_live_hold"))).toBe(
      false,
    );
  });

  it("does not retry an ordinary failure", () => {
    expect(isRetryableContention(pgError("42P01"))).toBe(false);
    expect(isRetryableContention(new Error("nope"))).toBe(false);
    expect(isRetryableContention(null)).toBe(false);
  });
});

describe("the two classifications together", () => {
  // Every loser must be one or the other, or somebody sees a generic error at
  // the exact moment a popular slot is being fought over.
  it("classifies every failure a lost race actually produces", () => {
    for (const code of ["23P01", "23505", "40P01", "40001"]) {
      const error = pgError(
        code,
        code === "23P01" ? "slot_holds_no_overlapping_live_hold" : undefined,
      );
      expect(isSlotTaken(error) || isRetryableContention(error)).toBe(true);
    }
  });

  it("never classifies the same failure as both", () => {
    for (const code of ["23P01", "23505", "40P01", "40001", "42P01"]) {
      const error = pgError(
        code,
        code === "23P01" ? "slot_holds_no_overlapping_live_hold" : undefined,
      );
      expect(isSlotTaken(error) && isRetryableContention(error)).toBe(false);
    }
  });
});

/*
  holdSlot itself, against a real Postgres with the real constraint - and
  against injected failures for the paths a database will not produce on
  demand.
*/
let db: PGlite;
let realTransaction: <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;

beforeAll(async () => {
  db = await PGlite.create();
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  realTransaction = async (work) => {
    await db.query("begin");
    try {
      const result = await work(db as unknown as QueryRunner);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  };
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const slot = (startIso: string) => ({
  slotStart: new Date(startIso),
  slotEnd: new Date(new Date(startIso).getTime() + 90 * 60_000),
  expiresAt: new Date(Date.now() + 15 * 60_000),
});

describe("holdSlot", () => {
  it("claims a free slot", async () => {
    const outcome = await holdSlot(slot("2027-01-04T06:00:00Z"), realTransaction);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.hold.id).toBeTruthy();
  });

  // The real thing: a genuine exclusion violation from the real constraint.
  it("reports the slot as taken when somebody else already holds it", async () => {
    const wanted = slot("2027-01-05T06:00:00Z");
    expect((await holdSlot(wanted, realTransaction)).ok).toBe(true);

    const second = await holdSlot(wanted, realTransaction);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("slot_taken");
  });

  it("reports overlapping - not only identical - slots as taken", async () => {
    await holdSlot(slot("2027-01-06T06:00:00Z"), realTransaction);
    const overlapping = await holdSlot(slot("2027-01-06T07:00:00Z"), realTransaction);
    expect(overlapping.ok).toBe(false);
  });

  it("allows a slot starting exactly when the previous one ends", async () => {
    await holdSlot(slot("2027-01-07T06:00:00Z"), realTransaction);
    const adjacent = await holdSlot(slot("2027-01-07T07:30:00Z"), realTransaction);
    expect(adjacent.ok).toBe(true);
  });

  /*
    The deadlock path, which only appeared at 25 concurrent contenders against
    the real database and cannot be produced on demand here.
  */
  it("retries once after a deadlock and succeeds", async () => {
    let calls = 0;
    const deadlockThenSucceed = async <T>(work: (runner: QueryRunner) => Promise<T>) => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("deadlock"), { code: "40P01" });
      return realTransaction(work);
    };

    const outcome = await holdSlot(slot("2027-01-08T06:00:00Z"), deadlockThenSucceed);
    expect(outcome.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("retries once, not forever", async () => {
    let calls = 0;
    const alwaysDeadlocks = () => {
      calls += 1;
      return Promise.reject(Object.assign(new Error("deadlock"), { code: "40P01" }));
    };

    await expect(holdSlot(slot("2027-01-09T06:00:00Z"), alwaysDeadlocks)).rejects.toThrow();
    expect(calls).toBe(2);
  });

  it("retries after a deadlock and reports a definite loss on the second try", async () => {
    let calls = 0;
    const deadlockThenTaken = () => {
      calls += 1;
      const code = calls === 1 ? "40P01" : "23P01";
      return Promise.reject(
        Object.assign(new Error("no"), { code, constraint: "slot_holds_no_overlapping_live_hold" }),
      );
    };

    const outcome = await holdSlot(slot("2027-01-10T06:00:00Z"), deadlockThenTaken);
    expect(outcome.ok).toBe(false);
  });

  /*
    A broken database reported as "that time has gone" would hide an outage
    behind a plausible message and send the customer to pick another slot that
    also will not work.
  */
  it("lets a genuine failure through rather than calling it a lost race", async () => {
    const broken = () => Promise.reject(Object.assign(new Error("no table"), { code: "42P01" }));
    await expect(holdSlot(slot("2027-01-11T06:00:00Z"), broken)).rejects.toThrow("no table");
  });
});

/*
  listLiveHolds decides what a customer is OFFERED, so the two things that
  matter are that a hold blocks its slot, and that it stops blocking the
  instant it expires - whether or not a sweep has run. A late cron must never
  take a sellable slot off the calendar.
*/
describe("listLiveHolds", () => {
  const WINDOW_FROM = new Date("2027-03-01T00:00:00Z");
  const WINDOW_TO = new Date("2027-03-08T00:00:00Z");
  const NOW = new Date("2027-03-01T09:00:00Z");

  const insert = (startIso: string, expiresAtIso: string, status = "held") =>
    db.query(
      `insert into slot_holds (slot_start, slot_end, expires_at, status)
       values ($1, $2, $3, $4) returning id`,
      [
        new Date(startIso),
        new Date(new Date(startIso).getTime() + 90 * 60_000),
        new Date(expiresAtIso),
        status,
      ],
    );

  it("returns a hold that is still live", async () => {
    await insert("2027-03-02T10:00:00Z", "2027-03-01T09:15:00Z");

    const holds = await listLiveHolds(
      db as unknown as QueryRunner,
      {
        from: WINDOW_FROM,
        to: WINDOW_TO,
      },
      NOW,
    );

    expect(holds.some((h) => h.slotStart.toISOString() === "2027-03-02T10:00:00.000Z")).toBe(true);
  });

  /*
    THE one that matters. An abandoned checkout must not hold a slot hostage
    until a cron run happens to notice - availability is never allowed to
    depend on the sweep having kept up.
  */
  it("ignores a hold whose expiry has passed, even though nothing has swept it", async () => {
    await insert("2027-03-03T10:00:00Z", "2027-03-01T08:59:00Z");

    const holds = await listLiveHolds(
      db as unknown as QueryRunner,
      {
        from: WINDOW_FROM,
        to: WINDOW_TO,
      },
      NOW,
    );

    expect(holds.some((h) => h.slotStart.toISOString() === "2027-03-03T10:00:00.000Z")).toBe(false);
  });

  it("ignores holds that already ended, whatever ended them", async () => {
    await insert("2027-03-04T10:00:00Z", "2027-03-01T23:00:00Z", "converted");
    await insert("2027-03-04T13:00:00Z", "2027-03-01T23:00:00Z", "released");
    await insert("2027-03-04T15:00:00Z", "2027-03-01T23:00:00Z", "expired");

    const holds = await listLiveHolds(
      db as unknown as QueryRunner,
      {
        from: WINDOW_FROM,
        to: WINDOW_TO,
      },
      NOW,
    );

    const onThatDay = holds.filter((h) => h.slotStart.toISOString().startsWith("2027-03-04"));
    expect(onThatDay).toEqual([]);
  });

  // Reading the whole table to render one week would get slower every month.
  it("does not return holds outside the window being shown", async () => {
    await insert("2027-04-20T10:00:00Z", "2027-03-01T23:00:00Z");

    const holds = await listLiveHolds(
      db as unknown as QueryRunner,
      {
        from: WINDOW_FROM,
        to: WINDOW_TO,
      },
      NOW,
    );

    expect(holds.some((h) => h.slotStart.toISOString().startsWith("2027-04"))).toBe(false);
  });

  // A hold that starts before the window but runs into it still blocks it.
  it("includes a hold that only overlaps the edge of the window", async () => {
    await insert("2027-02-28T23:30:00Z", "2027-03-01T23:00:00Z");

    const holds = await listLiveHolds(
      db as unknown as QueryRunner,
      {
        from: WINDOW_FROM,
        to: WINDOW_TO,
      },
      NOW,
    );

    expect(holds.some((h) => h.slotStart.toISOString() === "2027-02-28T23:30:00.000Z")).toBe(true);
  });

  it("hands back the domain shape, not database column names", async () => {
    await insert("2027-03-05T10:00:00Z", "2027-03-01T23:00:00Z");

    const holds = await listLiveHolds(
      db as unknown as QueryRunner,
      {
        from: WINDOW_FROM,
        to: WINDOW_TO,
      },
      NOW,
    );
    const hold = holds.find((h) => h.slotStart.toISOString() === "2027-03-05T10:00:00.000Z");

    expect(hold).toMatchObject({ status: "held", orderId: null, calendarEventId: null });
    expect(hold?.expiresAt).toBeInstanceOf(Date);
    expect(hold?.createdAt).toBeInstanceOf(Date);
  });
});

/*
  The sweep, against the real table.

  Two properties are worth more than the happy path: it must not expire a hold
  that is still live, and running it twice must not do the work twice.
*/
describe("claimExpiredHolds", () => {
  const NOW = new Date("2027-06-01T12:00:00Z");

  const insert = (startIso: string, expiresAtIso: string, eventId: string | null = null) =>
    db
      .query<{ id: string }>(
        `insert into slot_holds (slot_start, slot_end, expires_at, calendar_event_id)
         values ($1, $2, $3, $4) returning id`,
        [
          new Date(startIso),
          new Date(new Date(startIso).getTime() + 90 * 60_000),
          new Date(expiresAtIso),
          eventId,
        ],
      )
      .then((r) => r.rows[0]?.id ?? "");

  const statusOf = (id: string) =>
    db
      .query<{ status: string }>("select status from slot_holds where id = $1", [id])
      .then((r) => r.rows[0]?.status);

  it("expires a hold whose time has run out", async () => {
    const id = await insert("2027-06-02T10:00:00Z", "2027-06-01T11:45:00Z");

    const swept = await claimExpiredHolds(db as unknown as QueryRunner, NOW);

    expect(swept.some((hold) => hold.id === id)).toBe(true);
    expect(await statusOf(id)).toBe("expired");
  });

  /*
    A hold with two minutes left is somebody part way through paying. Expiring
    it would release the slot from under a customer at the card screen.
  */
  it("leaves a hold that has not expired alone", async () => {
    const id = await insert("2027-06-03T10:00:00Z", "2027-06-01T12:02:00Z");

    await claimExpiredHolds(db as unknown as QueryRunner, NOW);

    expect(await statusOf(id)).toBe("held");
  });

  // A cron firing while the previous run is still working is normal.
  it("does nothing on a second pass, so overlapping runs are safe", async () => {
    const id = await insert("2027-06-04T10:00:00Z", "2027-06-01T11:00:00Z");

    const first = await claimExpiredHolds(db as unknown as QueryRunner, NOW);
    const second = await claimExpiredHolds(db as unknown as QueryRunner, NOW);

    expect(first.some((hold) => hold.id === id)).toBe(true);
    expect(second.some((hold) => hold.id === id)).toBe(false);
    expect(await statusOf(id)).toBe("expired");
  });

  /*
    A hold that already converted into a booking must never be expired by a
    sweep - that would release the slot for a session somebody has paid for.
  */
  it("never touches a hold that already ended", async () => {
    const id = await insert("2027-06-05T10:00:00Z", "2027-06-01T11:00:00Z");
    await db.query("update slot_holds set status = 'converted' where id = $1", [id]);

    const swept = await claimExpiredHolds(db as unknown as QueryRunner, NOW);

    expect(swept.some((hold) => hold.id === id)).toBe(false);
    expect(await statusOf(id)).toBe("converted");
  });

  /*
    The event id has to come back, or the tentative entry keeps blocking the
    real calendar after we have released the hold.
  */
  it("returns the calendar event that still needs deleting", async () => {
    const id = await insert("2027-06-06T10:00:00Z", "2027-06-01T11:00:00Z", "graph-event-123");

    const swept = await claimExpiredHolds(db as unknown as QueryRunner, NOW);

    expect(swept.find((hold) => hold.id === id)?.calendarEventId).toBe("graph-event-123");
  });

  it("reports an empty sweep as empty rather than as an error", async () => {
    const swept = await claimExpiredHolds(
      db as unknown as QueryRunner,
      new Date("2020-01-01T00:00:00Z"),
    );
    expect(swept).toEqual([]);
  });

  // The slot goes back on sale the moment the hold is gone.
  it("frees the slot it was blocking", async () => {
    const id = await insert("2027-06-07T10:00:00Z", "2027-06-01T11:00:00Z");
    await claimExpiredHolds(db as unknown as QueryRunner, NOW);

    const outcome = await holdSlot(
      {
        slotStart: new Date("2027-06-07T10:00:00Z"),
        slotEnd: new Date("2027-06-07T11:30:00Z"),
        expiresAt: new Date("2027-06-01T12:15:00Z"),
      },
      realTransaction,
    );

    expect(outcome.ok).toBe(true);
    expect(await statusOf(id)).toBe("expired");
  });
});
