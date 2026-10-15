import type { QueryRunner } from "./db";
import type { RefundRowStatus } from "./refunds";
import { bookingReference } from "@/domain/booking/withdrawal";
import type { Fils } from "@/lib/money";

/**
 * Reading refunds: what the alarm and the desk alerts count, what the sweep
 * has to do next, and what a customer's email may say about their money.
 * Nothing here moves money or changes a refund's status; that is refunds.ts.
 */

/** A refund a person must look at, with what the desk needs to find it and nothing about the customer. */
export interface RefundNeedingAttention {
  readonly refundId: string;
  /** The booking's reference: the withdrawn booking, else the order's first. Null if it has none. */
  readonly bookingReference: string | null;
  readonly amountFils: Fils;
  readonly currency: string;
  readonly status: RefundRowStatus;
  /** The processor's error code, or one of ours (e.g. no_payment_intent); never a message. */
  readonly lastError: string | null;
  /** The payment to look up in Stripe. */
  readonly paymentIntentId: string | null;
}

/**
 * Refunds a person must look at. A failed or cancelled refund counts until
 * the order's succeeded refunds cover it, so one that is finished by hand in
 * the dashboard stops counting, and one that succeeded and then failed keeps
 * counting even though the order already says refunded. Also: refunds still
 * owed a day after they were written (counted from creation, since retries
 * move the row between due and issuing), and refunds whose status has stood
 * at pending for three days.
 *
 * The one place these conditions live: the alarm's count and the desk's
 * emails are both read from here.
 */
export async function listRefundsNeedingAttention(
  runner: QueryRunner,
  now: Date,
): Promise<readonly RefundNeedingAttention[]> {
  const result = await runner.query<{
    id: string;
    booking_id: string | null;
    amount_fils: string | number;
    currency: string;
    status: RefundRowStatus;
    last_error: string | null;
    stripe_payment_intent_id: string | null;
  }>(
    `select r.id, coalesce(w.booking_id,
                           (select b.id from bookings b where b.order_id = r.order_id
                             order by b.sequence, b.id limit 1)) as booking_id,
            r.amount_fils, r.currency, r.status, r.last_error, o.stripe_payment_intent_id
       from refunds r
       join orders o on o.id = r.order_id
       left join withdrawal_requests w on w.id = r.withdrawal_request_id
      where (r.status in ('failed', 'canceled')
             and (select coalesce(sum(s.amount_fils), 0) from refunds s
                   where s.order_id = r.order_id and s.status = 'succeeded') < o.gross_amount_fils)
         or (r.status in ('due', 'issuing') and r.created_at < $1::timestamptz - interval '1 day')
         or (r.status = 'pending' and r.status_changed_at < $1::timestamptz - interval '3 days')
      order by r.created_at, r.id`,
    [now],
  );
  return result.rows.map((row) => ({
    refundId: row.id,
    bookingReference: row.booking_id === null ? null : bookingReference(row.booking_id),
    amountFils: Number(row.amount_fils),
    currency: row.currency,
    status: row.status,
    lastError: row.last_error,
    paymentIntentId: row.stripe_payment_intent_id,
  }));
}

/** How many refunds need a person: the length of the list above. */
export async function countRefundsNeedingAttention(
  runner: QueryRunner,
  now: Date,
): Promise<number> {
  return (await listRefundsNeedingAttention(runner, now)).length;
}

/**
 * Whether the sweep has refund work this run. Asked first, so a run with none
 * never needs the processor configured.
 */
export async function refundWorkWaiting(runner: QueryRunner, now: Date): Promise<boolean> {
  const result = await runner.query<{ waiting: boolean }>(
    `select exists (
       select 1 from refunds
        where (status = 'due' and (next_attempt_at is null or next_attempt_at <= $1))
           or (status = 'issuing' and lease_until < $1)
           or (status = 'pending' and provider_refund_id is not null
               and coalesce(checked_at, status_changed_at) < $1::timestamptz - interval '1 hour')
     ) as waiting`,
    [now],
  );
  return result.rows[0]?.waiting === true;
}

/** Refunds pending with nothing new, and not asked about, for an hour: to read again. */
export async function listPendingRefundsToRefresh(
  runner: QueryRunner,
  now: Date,
  limit: number,
): Promise<readonly { id: string; providerRefundId: string }[]> {
  const result = await runner.query<{ id: string; provider_refund_id: string }>(
    `select id, provider_refund_id from refunds
      where status = 'pending' and provider_refund_id is not null
        and coalesce(checked_at, status_changed_at) < $1::timestamptz - interval '1 hour'
      order by coalesce(checked_at, status_changed_at)
      limit $2`,
    [now, limit],
  );
  return result.rows.map((row) => ({ id: row.id, providerRefundId: row.provider_refund_id }));
}

/** Note that the processor was asked about a refund. Touches nothing else on the row. */
export async function markRefundChecked(runner: QueryRunner, id: string, now: Date): Promise<void> {
  await runner.query(`update refunds set checked_at = $2 where id = $1`, [id, now]);
}

/**
 * What the acknowledgement may say about the money. Refunded only on success;
 * issued once the processor has the refund and it is still on its way;
 * otherwise the refund is still owed, whatever went wrong on the way.
 */
export function refundStateForEmail(
  refund: { status: RefundRowStatus; providerRefundId: string | null } | null,
): "succeeded" | "issued" | "owed" {
  if (refund?.status === "succeeded") return "succeeded";
  if (refund?.status === "pending" && refund.providerRefundId !== null) return "issued";
  return "owed";
}

/** Where a withdrawal's refund stands, for the acknowledgement email. */
export async function loadWithdrawalRefund(
  runner: QueryRunner,
  bookingId: string,
): Promise<{ status: RefundRowStatus; providerRefundId: string | null } | null> {
  const result = await runner.query<{ status: RefundRowStatus; provider_refund_id: string | null }>(
    `select r.status, r.provider_refund_id
       from refunds r join withdrawal_requests w on w.id = r.withdrawal_request_id
      where w.booking_id = $1`,
    [bookingId],
  );
  const row = result.rows[0];
  return row ? { status: row.status, providerRefundId: row.provider_refund_id } : null;
}
