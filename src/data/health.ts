import type { QueryRunner } from "./db";

/**
 * Work that should have finished by now and has not: the signs that the
 * sweep runs but something it depends on has quietly stopped (audit s101 #7).
 *
 * Each is a thing that, broken, would otherwise reach nobody: a desk alert
 * never sent means the desk's email is down (a Microsoft secret expired, say),
 * so the desk alarm cannot ring itself; customer emails long overdue mean
 * customers are not hearing from us; a refund owed and not issued means money
 * the law says we owe is not going back. Two hours each, well past any normal
 * retry, so one bad minute never raises it.
 */

export type StuckWork = "desk_alerts_unsent" | "customer_emails_overdue" | "refunds_overdue";

/** Long enough that ordinary retries (half an hour for alerts, doubling for emails) have run. */
const STUCK_AFTER = "2 hours";

export async function findStuckWork(runner: QueryRunner, now: Date): Promise<readonly StuckWork[]> {
  const result = await runner.query<{
    alerts: boolean;
    emails: boolean;
    refunds: boolean;
  }>(
    `select
       exists (select 1 from desk_alerts
                where resolved_at is null and sends = 0
                  and first_raised_at < $1::timestamptz - interval '${STUCK_AFTER}') as alerts,
       exists (select 1 from communication_log
                where status = 'queued'
                  and scheduled_for < $1::timestamptz - interval '${STUCK_AFTER}') as emails,
       exists (select 1 from refunds
                where status in ('due', 'issuing')
                  and created_at < $1::timestamptz - interval '${STUCK_AFTER}') as refunds`,
    [now],
  );
  const row = result.rows[0];
  const stuck: StuckWork[] = [];
  if (row?.alerts) stuck.push("desk_alerts_unsent");
  if (row?.emails) stuck.push("customer_emails_overdue");
  if (row?.refunds) stuck.push("refunds_overdue");
  return stuck;
}
