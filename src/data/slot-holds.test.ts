import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll } from "vitest";
import { holdSlot, isRetryableContention, isSlotTaken } from "./slot-holds";
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
