import type { QueryRunner } from "./db";

/**
 * Orders whose checkout result never arrived as an event, and the record that
 * one was settled by asking instead.
 *
 * An order is still pending well after its checkout could have ended only if
 * the processor's event was lost: the webhook secret was wrong, the endpoint
 * disabled, or the host down past the processor's days of retries. The sweep
 * asks about each one and applies the answer exactly as the event would have.
 */

/** Longer than the checkout (30 min) and its hold (35 min), so a live checkout is never asked about. */
export const RECONCILE_AFTER_MINUTES = 40;
/** Short of the 30-day purge of pending orders, so nothing is deleted before it is asked about. */
const RECONCILE_WITHIN_DAYS = 29;
/** How long a rescue keeps the desk alert standing: something is wrong with the events until fixed. */
const ALERT_FOR_HOURS = 24;

export interface OrderToReconcile {
  readonly orderId: string;
  readonly checkoutSessionId: string;
}

export async function listOrdersToReconcile(
  runner: QueryRunner,
  now: Date,
  limit: number,
): Promise<readonly OrderToReconcile[]> {
  const result = await runner.query<{ id: string; stripe_checkout_session_id: string }>(
    `select id, stripe_checkout_session_id from orders
      where payment_status = 'pending' and stripe_checkout_session_id is not null
        and created_at <= $1::timestamptz - make_interval(mins => $2)
        and created_at > $1::timestamptz - make_interval(days => $3)
      -- Least recently asked first: an order that never settles takes its turn and steps aside.
      order by reconcile_checked_at nulls first, created_at
      limit $4`,
    [now, RECONCILE_AFTER_MINUTES, RECONCILE_WITHIN_DAYS, limit],
  );
  return result.rows.map((row) => ({
    orderId: row.id,
    checkoutSessionId: row.stripe_checkout_session_id,
  }));
}

/** The order was settled by asking: its event never came. */
export async function markReconciled(runner: QueryRunner, orderId: string, now: Date) {
  await runner.query(`update orders set reconciled_at = $2 where id = $1`, [orderId, now]);
}

/** Note that the order was asked about, and whether the asking failed. */
export async function markChecked(
  runner: QueryRunner,
  orderId: string,
  now: Date,
  error: string | null,
): Promise<void> {
  await runner.query(
    `update orders set reconcile_checked_at = $2, reconcile_error = $3 where id = $1`,
    [orderId, now, error === null ? null : error.slice(0, 100)],
  );
}

/** How long the asking may fail before the desk is told the safety net itself is down. */
const FAILING_FOR_HOURS = 3;

/**
 * Pending orders the processor could not be asked about, still failing hours
 * after their checkout: the safety net itself is down (a key revoked, a
 * permission removed), and nobody else would notice.
 */
export async function countFailingReconciliation(runner: QueryRunner, now: Date): Promise<number> {
  const result = await runner.query<{ n: number }>(
    `select count(*)::int as n from orders
      where payment_status = 'pending' and reconcile_error is not null
        and created_at <= $1::timestamptz - make_interval(hours => $2)`,
    [now, FAILING_FOR_HOURS],
  );
  return result.rows[0]?.n ?? 0;
}

/** Orders rescued in the last day: while there are any, the desk is told the events are missing. */
export async function countRecentlyReconciled(runner: QueryRunner, now: Date): Promise<number> {
  const result = await runner.query<{ n: number }>(
    `select count(*)::int as n from orders
      where reconciled_at > $1::timestamptz - make_interval(hours => $2)`,
    [now, ALERT_FOR_HOURS],
  );
  return result.rows[0]?.n ?? 0;
}
