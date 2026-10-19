import { logger } from "./logger";

/**
 * Checking in with the outside monitor (Healthchecks.io's ping protocol): a
 * request to the URL says "ran, all well"; to the URL with `/fail` appended,
 * "ran, and something needs a person". If neither arrives in time, the
 * monitor raises the alarm itself, which is the whole point: a sweep that has
 * stopped cannot report that it stopped.
 *
 * Never throws and never waits long. The monitor being slow or down must not
 * make the sweep fail; at worst the founder hears a false alarm.
 */

const TIMEOUT_MS = 5_000;

export interface HeartbeatResult {
  readonly sent: boolean;
  readonly outcome: "ok" | "fail";
}

export async function checkIn(
  url: string | undefined,
  problems: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<HeartbeatResult | null> {
  if (!url) return null;
  const outcome = problems.length === 0 ? "ok" : "fail";
  const target = outcome === "ok" ? url : `${url.replace(/\/+$/, "")}/fail`;
  try {
    const response = await fetchImpl(target, {
      method: "POST",
      // What failed, by name only: the monitor keeps the body in its log.
      body: problems.join(", "),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn("the heartbeat monitor did not accept the check-in", {
        status: response.status,
      });
      return { sent: false, outcome };
    }
    return { sent: true, outcome };
  } catch (error) {
    logger.warn("the heartbeat monitor could not be reached", { error: (error as Error).name });
    return { sent: false, outcome };
  }
}
