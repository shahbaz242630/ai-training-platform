import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogSink, setLogSink } from "@/lib/logger";

const state = vi.hoisted(() => ({ databaseDown: false, stuck: [] as string[] }));

vi.mock("@/data/db", () => ({
  withTransaction: async <T>(work: (runner: unknown) => Promise<T>): Promise<T> => {
    if (state.databaseDown) throw new Error("connection refused");
    return work({});
  },
}));

vi.mock("@/data/health", () => ({
  findStuckWork: () => Promise.resolve(state.stuck),
}));

import { healthProblems } from "./heartbeat-step";

/**
 * What the sweep tells the monitor is wrong: a database behind the code,
 * stuck work, or a health check that could not run, which is never read as
 * all well.
 */

const NOW = new Date("2027-05-01T12:00:00Z");
const current = { expected: "1", applied: "1", current: true };

beforeEach(() => {
  state.databaseDown = false;
  state.stuck = [];
  setLogSink(() => undefined);
});
afterEach(() => resetLogSink());

describe("healthProblems", () => {
  it("is empty when the database is current and nothing is stuck", async () => {
    expect(await healthProblems(current, NOW)).toEqual([]);
  });

  it("names a database behind the code and the stuck work together", async () => {
    state.stuck = ["refunds_overdue"];
    expect(await healthProblems({ ...current, current: false }, NOW)).toEqual([
      "schema_behind",
      "refunds_overdue",
    ]);
  });

  it("reports a check that could not run, never mistaking it for all well", async () => {
    state.databaseDown = true;
    expect(await healthProblems(current, NOW)).toEqual(["health_check_failed"]);
  });
});
