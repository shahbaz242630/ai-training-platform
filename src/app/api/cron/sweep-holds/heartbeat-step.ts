import { withTransaction } from "@/data/db";
import { findStuckWork } from "@/data/health";
import type { SchemaStatus } from "@/data/schema-version";
import { serverEnv } from "@/lib/env";
import { checkIn, type HeartbeatResult } from "@/lib/heartbeat";
import { logger } from "@/lib/logger";

/**
 * The sweep's last step: check in with the outside monitor (audit s101 #7).
 * "fail" when the database is behind the code or work is stuck; nothing at
 * all, for the monitor to notice, when the sweep stops running.
 */
export async function heartbeatStep(
  schema: SchemaStatus,
  now: Date,
): Promise<HeartbeatResult | null> {
  return checkIn(serverEnv().HEARTBEAT_URL, await healthProblems(schema, now));
}

/** A sweep failing every run looks, from outside, like one that runs: the monitor hears it. */
export async function heartbeatFailed(): Promise<void> {
  await checkIn(serverEnv().HEARTBEAT_URL, ["sweep_failed"]);
}

/**
 * What the monitor is told is wrong. Its own failure domain: a check that
 * cannot run is itself reported, never mistaken for all well.
 */
export async function healthProblems(schema: SchemaStatus, now: Date): Promise<readonly string[]> {
  const problems: string[] = schema.current ? [] : ["schema_behind"];
  try {
    problems.push(...(await withTransaction((runner) => findStuckWork(runner, now))));
  } catch (error) {
    logger.error("the health check could not run", { error: (error as Error).name });
    problems.push("health_check_failed");
  }
  return problems;
}
