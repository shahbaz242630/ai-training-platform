import { createRateLimiter } from "./rate-limit";

/**
 * How much durable evidence a rejected request is allowed to leave behind.
 *
 * THE PROBLEM THIS SOLVES. A signature failure on the payment webhook is worth
 * recording: it is either a misconfiguration or somebody probing a money
 * endpoint, and both deserve a row in the audit trail rather than a log line
 * that rotates away. But the audit table is append-only by design and the
 * webhook is public. Recording every rejection meant anybody who could reach
 * the URL could grow that table one row per request, forever, having
 * authenticated nothing - and the table refuses DELETE and TRUNCATE, so
 * cleaning up afterwards would mean dropping the triggers that make it
 * evidence in the first place.
 *
 * So evidence is budgeted. The first few rejections from a source in each
 * window are recorded; after that they are still refused and still logged,
 * just not written to the trail. A second, total budget holds even when the
 * source cannot be told apart: a proxy chain longer than assumed puts every
 * caller behind one address, and no proxy at all puts them all in the
 * unknown bucket. Either way the table is bounded.
 *
 * The response to the caller is not this module's concern and does not
 * change. This decides only whether a row is written.
 */

export interface EvidenceBudgetOptions {
  /** Rows one source may leave per window. */
  readonly perSource: number;
  /** Rows all sources together may leave per window. */
  readonly total: number;
  readonly windowMs: number;
}

export interface EvidenceBudget {
  /**
   * Whether this rejection should be written to the durable trail. Spends
   * budget when it says yes, so call it once per rejection.
   */
  shouldRecord(source: string, now: Date): boolean;
}

export function createEvidenceBudget(options: EvidenceBudgetOptions): EvidenceBudget {
  const perSource = createRateLimiter({ limit: options.perSource, windowMs: options.windowMs });
  const total = createRateLimiter({ limit: options.total, windowMs: options.windowMs });

  return {
    shouldRecord(source: string, now: Date): boolean {
      /*
        Per-source first, and the total only when the source still has
        allowance. The other order would let one noisy source spend the
        shared budget on rejections that were never going to be recorded,
        silencing evidence from everybody else.
      */
      return perSource.check(source, now).allowed && total.check("total", now).allowed;
    },
  };
}
