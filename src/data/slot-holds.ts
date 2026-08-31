import { withTransaction, type QueryRunner } from "./db";
import { sweepExpiredHolds, type SlotHold, type SlotHoldStatus } from "@/domain/booking/slot-hold";

/**
 * Claiming a time slot, and losing that race gracefully.
 *
 * The guarantee itself is a database constraint - two overlapping live holds
 * cannot both exist, and no amount of checking-then-inserting in application
 * code achieves that, because the other request commits between the check and
 * the insert. This module is about what the LOSER is told.
 *
 * Postgres reports the loss in more than one way, which is the part worth
 * knowing and was measured rather than assumed. Racing real connections
 * against the real database:
 *
 *   2, 3 and 8 contenders  -> every loser got 23P01, the exclusion violation
 *   25 contenders          -> the losers got 40P01, DEADLOCK DETECTED
 *
 * Both mean "somebody else got there first", and exactly one hold existed
 * afterwards in every run. Code that recognised only 23P01 would show a
 * correct "that time has gone" message under light contention and a generic
 * "something went wrong" under heavy contention - which is precisely when a
 * popular slot is being fought over and the message matters most.
 */

/** unique_violation and exclusion_violation: a definite, final loss. */
const EXCLUSION_VIOLATION = "23P01";
const UNIQUE_VIOLATION = "23505";

/**
 * Deadlock and serialization failure. These mean "the database untangled
 * concurrent work by aborting this one" - not, by itself, that the slot is
 * taken. Worth exactly one retry, which either succeeds or comes back as a
 * definite loss.
 */
const DEADLOCK_DETECTED = "40P01";
const SERIALIZATION_FAILURE = "40001";

const OVERLAP_CONSTRAINT = "slot_holds_no_overlapping_live_hold";

interface PostgresError {
  readonly code?: string;
  readonly constraint?: string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as PostgresError).code : undefined;
}

/** A definite loss: somebody else holds this slot and that is settled. */
export function isSlotTaken(error: unknown): boolean {
  const code = errorCode(error);
  if (code === UNIQUE_VIOLATION) return true;
  if (code !== EXCLUSION_VIOLATION) return false;
  const constraint = (error as PostgresError).constraint;
  // Named explicitly so a future exclusion constraint on some other table is
  // not silently reported to a customer as "that time has gone".
  return constraint === undefined || constraint === OVERLAP_CONSTRAINT;
}

/** Contention rather than a verdict. Retryable exactly once. */
export function isRetryableContention(error: unknown): boolean {
  const code = errorCode(error);
  return code === DEADLOCK_DETECTED || code === SERIALIZATION_FAILURE;
}

interface SlotHoldRow {
  readonly id: string;
  readonly slot_start: Date;
  readonly slot_end: Date;
  readonly order_id: string | null;
  readonly calendar_event_id: string | null;
  readonly expires_at: Date;
  readonly status: SlotHoldStatus;
  readonly created_at: Date;
}

/** Rows in, domain type out. Nothing above this line knows about column names. */
function toSlotHold(row: SlotHoldRow): SlotHold {
  return {
    id: row.id,
    slotStart: row.slot_start,
    slotEnd: row.slot_end,
    orderId: row.order_id,
    calendarEventId: row.calendar_event_id,
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
  };
}

export interface HoldSlotInput {
  /** UTC, both. */
  readonly slotStart: Date;
  readonly slotEnd: Date;
  readonly expiresAt: Date;
  readonly orderId?: string | null;
  readonly calendarEventId?: string | null;
}

export interface HeldSlot {
  readonly id: string;
  readonly expiresAt: Date;
}

export type HoldOutcome =
  | { readonly ok: true; readonly hold: HeldSlot }
  /** Somebody else got there first. Not an error - a race one customer loses. */
  | { readonly ok: false; readonly reason: "slot_taken" };

async function insertHold(runner: QueryRunner, input: HoldSlotInput): Promise<HeldSlot> {
  const result = await runner.query<{ id: string; expires_at: Date }>(
    `insert into slot_holds (slot_start, slot_end, expires_at, order_id, calendar_event_id)
     values ($1, $2, $3, $4, $5)
     returning id, expires_at`,
    [
      input.slotStart,
      input.slotEnd,
      input.expiresAt,
      input.orderId ?? null,
      input.calendarEventId ?? null,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("insertHold stored nothing, which should be impossible");
  return { id: row.id, expiresAt: row.expires_at };
}

/**
 * Claim the slot, or report that it has gone.
 *
 * Only a lost race returns `slot_taken`. Anything else - a dropped
 * connection, a syntax error, a missing table - still throws, because
 * reporting a broken database to a customer as "that time has gone" would
 * hide an outage behind a plausible message and send them off to pick another
 * slot that also will not work.
 */
export type TransactionRunner = <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;

/** The real one. Injected rather than reached for, so this is testable at all. */
const defaultTransaction: TransactionRunner = (work) => withTransaction(work);

export async function holdSlot(
  input: HoldSlotInput,
  runTransaction: TransactionRunner = defaultTransaction,
): Promise<HoldOutcome> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const hold = await runTransaction((runner) => insertHold(runner, input));
      return { ok: true, hold };
    } catch (error) {
      if (isSlotTaken(error)) return { ok: false, reason: "slot_taken" };

      /*
        One retry, and only one. A deadlock means the database untangled
        concurrent work by aborting this transaction, not that the slot is
        gone - so it is worth trying again, once. The second attempt either
        succeeds or comes back as a definite loss. Retrying indefinitely under
        contention is how a popular slot turns into a queue of stuck requests.
      */
      if (isRetryableContention(error) && attempt === 1) continue;
      throw error;
    }
  }
  // Unreachable: the loop either returns or throws on the second attempt.
  throw new Error("holdSlot exhausted its attempts without a verdict");
}

/**
 * The holds that still block a slot, within the window being shown.
 *
 * Expiry is applied HERE in SQL as well as by status, deliberately. A hold
 * whose fifteen minutes ran out two seconds ago is not blocking anything, and
 * availability must not depend on whether the sweep has caught up with it yet
 * - a late cron run must never take a sellable slot off the calendar.
 *
 * Returns the domain type rather than rows, so the same `isSlotAvailable` the
 * tests exercise is what decides what a customer is offered.
 */
export async function listLiveHolds(
  runner: QueryRunner,
  window: { readonly from: Date; readonly to: Date },
  now: Date,
): Promise<readonly SlotHold[]> {
  const result = await runner.query<SlotHoldRow>(
    `select id, slot_start, slot_end, order_id, calendar_event_id,
            expires_at, status, created_at
       from slot_holds
      where status = 'held'
        and expires_at > $3
        and slot_start < $2
        and slot_end > $1
      order by slot_start`,
    [window.from, window.to, now],
  );
  return result.rows.map(toSlotHold);
}

/**
 * The sweep: end the holds whose time ran out, and say which calendar events
 * need deleting as a result.
 *
 * Two runs of this can overlap - a cron that fires every five minutes while a
 * previous run is still working is normal, not exceptional. `for update skip
 * locked` is what makes that safe: the second run steps over the rows the
 * first has already claimed instead of blocking behind them or expiring them
 * twice.
 *
 * The decision about WHICH holds expire is made by the domain, not by this
 * SQL. That is deliberate - `sweepExpiredHolds` applies the transition table,
 * so a hold can only reach `expired` by a move the table permits. A bare
 * `update ... where expires_at < now()` would be shorter and would quietly
 * route around the one place that says which state changes are legal.
 *
 * Returns the holds it ended, each still carrying its `calendarEventId`: the
 * tentative event has to be deleted too, or the slot stays blocked on the real
 * calendar even though the hold is gone.
 */
export async function claimExpiredHolds(
  runner: QueryRunner,
  now: Date,
  limit = 200,
): Promise<readonly SlotHold[]> {
  const claimed = await runner.query<SlotHoldRow>(
    `select id, slot_start, slot_end, order_id, calendar_event_id,
            expires_at, status, created_at
       from slot_holds
      where status = 'held'
        and expires_at <= $1
      order by expires_at
      limit $2
      for update skip locked`,
    [now, limit],
  );

  const expired = sweepExpiredHolds(claimed.rows.map(toSlotHold), now);
  if (expired.length === 0) return [];

  await runner.query(`update slot_holds set status = 'expired' where id = any($1::uuid[])`, [
    expired.map((hold) => hold.id),
  ]);

  return expired;
}

/**
 * Give a hold back, by id.
 *
 * Used when something after the hold fails - the payment session could not be
 * created, say. Without it, a failure on that path would leave a sellable slot
 * blocked for the full fifteen minutes for no reason at all.
 *
 * Only a LIVE hold is released. One that already converted is a paid booking
 * and must never be given away by a cleanup path; one that already expired
 * needs nothing doing. Both simply match no row.
 */
export async function releaseHoldById(runner: QueryRunner, holdId: string): Promise<boolean> {
  const result = await runner.query<{ id: string }>(
    `update slot_holds
        set status = 'released'
      where id = $1 and status = 'held'
      returning id`,
    [holdId],
  );
  return result.rows.length > 0;
}
