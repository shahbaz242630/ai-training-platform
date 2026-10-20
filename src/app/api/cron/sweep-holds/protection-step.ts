import { renderDatabaseNearFull, renderHoldsNearCap } from "@/components/emails/protection-alert";
import type { QueryRunner } from "@/data/db";
import {
  openSubjectKeys,
  reconcileDeskAlerts,
  type DeskAlertReport,
  type DeskProblem,
} from "@/data/desk-alerts";
import { countLiveHolds } from "@/data/slot-holds";
import type { EmailProvider } from "@/domain/messaging/provider";
import { MAX_LIVE_HOLDS } from "@/domain/booking/slot-hold";
import { logger } from "@/lib/logger";

/**
 * The sweep's watch on the booking's own protections (audit s104 COA-1,
 * COA-2, PAY-1). Both are attacks that otherwise make no sound: refusals go
 * only to the browser that was refused, and a filling database says nothing
 * until it stops.
 *
 *   - Unpaid holds near the diary's cap: at the cap every new customer is
 *     turned away, and nobody but that customer knew.
 *   - The database near its plan's limit: at the limit it turns read-only,
 *     and checkout, settlement and every email stop.
 *
 * State, read each run, not counted refusals: nothing is written per refused
 * request, so an attack cannot make this step itself fill the database. In
 * its own failure, like every desk alert.
 */

/** Warn at this share of the diary's cap: early enough to act, late enough to be real. */
export const HOLDS_WARNING_SHARE = 0.8;
/** Once raised, the alert stays open until the holds fall to this share. */
export const HOLDS_CLEAR_SHARE = 0.5;

/** The database's size limit on the current (Free) plan. Raise it with the plan. */
export const DATABASE_LIMIT_BYTES = 500 * 1024 * 1024;

/** Warn at this share of the limit: days of headroom at normal growth, about an hour under attack. */
export const DATABASE_WARNING_SHARE = 0.7;
/** Once raised, the alert stays open until the database falls to this share. */
export const DATABASE_CLEAR_SHARE = 0.6;

const HOLDS_KEY = "holds:near-cap";
const DATABASE_KEY = "database:size";

const MB = 1024 * 1024;

export interface ProtectionDeps {
  readonly transaction: <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;
  /** Asked for only when there is something to send. */
  readonly email: () => EmailProvider;
  readonly clock: () => Date;
  readonly desk: () => string;
  /** The plan's limit; a test passes a small one. */
  readonly databaseLimitBytes?: number;
}

export interface ProtectionReport extends DeskAlertReport {
  readonly liveHolds: number;
  readonly databaseMb: number;
}

export async function protectionAlerts(
  deps: ProtectionDeps,
): Promise<ProtectionReport | { error: string }> {
  try {
    const limitBytes = deps.databaseLimitBytes ?? DATABASE_LIMIT_BYTES;
    const { liveHolds, databaseBytes, open } = await deps.transaction(async (runner) => ({
      liveHolds: await countLiveHolds(runner, deps.clock()),
      databaseBytes: await databaseSize(runner),
      open: await openSubjectKeys(runner, "booking_protection"),
    }));

    /*
      Raised at the warning line, closed only well below it: a count hovering
      at the line (which an attacker can arrange) must not open, close and
      email again every five minutes (audit s104 review).
    */
    const holdsLine = Math.ceil(
      MAX_LIVE_HOLDS * (open.has(HOLDS_KEY) ? HOLDS_CLEAR_SHARE : HOLDS_WARNING_SHARE),
    );
    const databaseLine =
      limitBytes * (open.has(DATABASE_KEY) ? DATABASE_CLEAR_SHARE : DATABASE_WARNING_SHARE);

    const problems: DeskProblem[] = [];
    if (liveHolds >= holdsLine) {
      logger.warn("unpaid holds are near the diary's cap", { liveHolds, cap: MAX_LIVE_HOLDS });
      problems.push({
        subjectKey: HOLDS_KEY,
        render: (reminder) => renderHoldsNearCap(liveHolds, MAX_LIVE_HOLDS, reminder),
      });
    }
    if (databaseBytes >= databaseLine) {
      logger.error("the database is near its plan's size limit", {
        databaseMb: Math.round(databaseBytes / MB),
      });
      problems.push({
        subjectKey: DATABASE_KEY,
        render: (reminder) =>
          renderDatabaseNearFull(
            Math.round(databaseBytes / MB),
            Math.round(limitBytes / MB),
            reminder,
          ),
      });
    }

    const report = await reconcileDeskAlerts(
      "booking_protection",
      problems,
      { email: deps.email, transaction: deps.transaction, clock: deps.clock },
      deps.desk(),
    );
    return { ...report, liveHolds, databaseMb: Math.round(databaseBytes / MB) };
  } catch (error) {
    logger.error("the protection alerts could not be checked; they will be tried again next run", {
      error: (error as Error).name,
    });
    return { error: "protection alerts could not be checked" };
  }
}

/** The whole database's size on disk, which is what the plan limit counts. */
async function databaseSize(runner: QueryRunner): Promise<number> {
  const result = await runner.query<{ bytes: string | number }>(
    `select pg_database_size(current_database()) as bytes`,
  );
  return Number(result.rows[0]?.bytes ?? 0);
}
