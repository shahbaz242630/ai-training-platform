import type { QueryRunner } from "./db";
import { lockOrder } from "./settlement";
import { transitionPayment, type PaymentStatus } from "@/domain/booking/order";
import { InvalidTransitionError } from "@/domain/booking/transitions";
import type { IssuedRefund, RefundEvent, RefundStatus } from "@/domain/payments/provider";
import type { Fils } from "@/lib/money";

/**
 * Refunds: the row written with a withdrawal, the claim that lets one sweep
 * run ask the processor for it, and what the processor's refund events do to
 * the row and its order.
 *
 * The rules that keep money from going out twice:
 *   - a refund is asked for only by the run holding its claim;
 *   - a request whose result is unknown is repeated with the SAME key, so the
 *     processor answers with the refund it already made;
 *   - the key moves on only after a clear refusal, which made nothing.
 * And the rule that keeps money owed from being forgotten: anything that
 * cannot finish by itself ends `failed`, and failed rows raise the alarm
 * until the money is shown to have gone back.
 */

export type RefundRowStatus =
  "due" | "issuing" | "pending" | "succeeded" | "failed" | "canceled" | "superseded";

/** Attempts before a refund is left for a person. */
export const MAX_REFUND_ATTEMPTS = 8;

/**
 * How long a claim lasts. Far longer than one request can take: the adapter
 * gives up after 15 seconds and retries once, so a run that is still working
 * never loses its claim to the next one.
 */
const LEASE_MINUTES = 5;

/**
 * Wait before attempt n + 1, in minutes. All eight attempts land within about
 * sixteen hours of the first, inside the 24 hours Stripe keeps a key's answer,
 * so every repeat of an unclear request is answered from that key.
 */
const BACKOFF_MINUTES = [5, 10, 30, 60, 120, 240, 480];

/**
 * The oldest a key may be when it is sent again: an hour inside Stripe's 24.
 * Past this (the sweep was down, say) the request is not repeated; a person
 * checks the dashboard instead, because an expired key could refund twice.
 */
export const KEY_WINDOW_MINUTES = 23 * 60;

/** How long to wait after the given attempt (1 for the first) before the next. */
export function backoffMinutes(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), BACKOFF_MINUTES.length) - 1;
  return BACKOFF_MINUTES[index] ?? 480;
}

const minutesAfter = (now: Date, minutes: number) => new Date(now.getTime() + minutes * 60_000);

export interface WithdrawalRefundInput {
  readonly orderId: string;
  readonly withdrawalRequestId: string;
  readonly amountFils: Fils;
  readonly now: Date;
}

/**
 * Write the refund a withdrawal is owed. In the same transaction as the
 * notice. One per notice: asking again returns the row already written.
 */
export async function createWithdrawalRefund(
  runner: QueryRunner,
  input: WithdrawalRefundInput,
): Promise<string> {
  await runner.query(
    `insert into refunds (order_id, withdrawal_request_id, origin, amount_fils, currency, status,
                          created_at, updated_at)
     select o.id, $2, 'withdrawal', $3, o.currency, 'due', $4, $4
       from orders o where o.id = $1
     on conflict (withdrawal_request_id) do nothing`,
    [input.orderId, input.withdrawalRequestId, input.amountFils, input.now],
  );
  const result = await runner.query<{ id: string }>(
    `select id from refunds where withdrawal_request_id = $1`,
    [input.withdrawalRequestId],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`order ${input.orderId} vanished while its refund was written`);
  return id;
}

export interface ClaimedRefund {
  readonly id: string;
  readonly orderId: string;
  readonly amountFils: Fils;
  /** Including this one. */
  readonly attempts: number;
  readonly keySeq: number;
  /** When this key was first sent; set by the claim that first uses it. */
  readonly keyFirstUsedAt: Date;
  readonly paymentIntentId: string | null;
  readonly orderPaymentStatus: PaymentStatus;
}

/**
 * Claim refunds to ask for: due ones whose wait is over, and ones whose
 * claim ran out because the run holding it died. The attempt is counted here,
 * before anything is sent, so a run that dies mid-request still shows it.
 * Commit this before calling the processor.
 */
export async function claimDueRefunds(
  runner: QueryRunner,
  now: Date,
  limit: number,
): Promise<readonly ClaimedRefund[]> {
  const result = await runner.query<{
    id: string;
    order_id: string;
    amount_fils: string | number;
    attempts: number;
    key_seq: number;
    key_first_used_at: Date;
    stripe_payment_intent_id: string | null;
    payment_status: PaymentStatus;
  }>(
    `with claimed as (
       update refunds
          set status = 'issuing', lease_until = $3, attempts = attempts + 1, updated_at = $1,
              key_first_used_at = coalesce(key_first_used_at, $1)
        where id in (
          select id from refunds
           where (status = 'due' and (next_attempt_at is null or next_attempt_at <= $1))
              or (status = 'issuing' and lease_until < $1)
           order by created_at
           limit $2
           for update skip locked
        )
        returning id, order_id, amount_fils, attempts, key_seq, key_first_used_at
     )
     select c.*, o.stripe_payment_intent_id, o.payment_status
       from claimed c join orders o on o.id = c.order_id
      order by c.id`,
    [now, limit, minutesAfter(now, LEASE_MINUTES)],
  );
  return result.rows.map((row) => ({
    id: row.id,
    orderId: row.order_id,
    amountFils: Number(row.amount_fils),
    attempts: row.attempts,
    keySeq: row.key_seq,
    keyFirstUsedAt: row.key_first_used_at,
    paymentIntentId: row.stripe_payment_intent_id,
    orderPaymentStatus: row.payment_status,
  }));
}

/** The key a claimed refund is asked for with. Never random. */
export function refundIdempotencyKey(claimed: ClaimedRefund): string {
  return `refund:${claimed.id}:${claimed.keySeq}`;
}

/** Whether the claim's key is too old to send again safely. */
export function keyWindowPassed(claimed: ClaimedRefund, now: Date): boolean {
  return now.getTime() - claimed.keyFirstUsedAt.getTime() > KEY_WINDOW_MINUTES * 60_000;
}

export type OrderRefundMove = "refunded" | "partially_refunded" | "unchanged" | "refused";

/**
 * The processor made the refund. Kept with its id, from `issuing` or from
 * `due` (a claim that ran out while this request was still answering): a due
 * row must never hold a refund id, or it would be asked for again. If one of
 * the processor's events already said more about it, that stands: the answer
 * to a request can arrive after the event the request caused.
 */
export async function recordRefundIssued(
  runner: QueryRunner,
  claimed: ClaimedRefund,
  issued: IssuedRefund,
  now: Date,
): Promise<OrderRefundMove> {
  await lockOrder(runner, claimed.orderId);
  await runner.query(
    `update refunds
        set provider_refund_id = coalesce(provider_refund_id, $2),
            status = case when status in ('issuing', 'due') then $3 else status end,
            lease_until = null, next_attempt_at = null, last_error = null, updated_at = $4
      where id = $1`,
    [claimed.id, issued.providerRefundId, issued.status, now],
  );
  return recomputeOrderRefunds(runner, claimed.orderId, now);
}

export interface RetryReason {
  /** The processor's error code, never its message. */
  readonly code: string;
  /** True only after a clear refusal, which made nothing: a new key is then safe. */
  readonly newKey: boolean;
}

/**
 * The request did not make a refund we know of. Back to due with a wait, or,
 * after the last attempt, failed for a person to finish. Only while the row
 * is still this run's claim: if a processor event already said what happened,
 * that stands, and nothing is retried or failed.
 */
export async function recordRefundRetry(
  runner: QueryRunner,
  claimed: ClaimedRefund,
  reason: RetryReason,
  now: Date,
): Promise<"retry" | "gave_up" | "already_settled"> {
  const code = reason.code.slice(0, 100);
  if (claimed.attempts >= MAX_REFUND_ATTEMPTS) {
    return (await closeRefund(runner, claimed.id, "failed", code, now))
      ? "gave_up"
      : "already_settled";
  }
  const wait = backoffMinutes(claimed.attempts);
  // A new key starts its own 24 hours from its first use.
  const moved = await runner.query<{ id: string }>(
    `update refunds
        set status = 'due', lease_until = null, last_error = $2, next_attempt_at = $3,
            key_seq = key_seq + $4,
            key_first_used_at = case when $4 = 1 then null else key_first_used_at end,
            updated_at = $5
      where id = $1 and status = 'issuing'
      returning id`,
    [claimed.id, code, minutesAfter(now, wait), reason.newKey ? 1 : 0, now],
  );
  return moved.rows.length === 1 ? "retry" : "already_settled";
}

/**
 * End a claimed refund that will not be asked for again: failed (alarm) or
 * superseded (nothing owed). Only while it is still this run's claim, so a
 * processor event that already wrote the real outcome is never overwritten.
 * True when it closed the row.
 */
export async function closeRefund(
  runner: QueryRunner,
  id: string,
  status: "failed" | "superseded",
  code: string | null,
  now: Date,
): Promise<boolean> {
  const closed = await runner.query<{ id: string }>(
    `update refunds
        set status = $2, last_error = coalesce($3, last_error), lease_until = null,
            next_attempt_at = null, updated_at = $4
      where id = $1 and status = 'issuing'
      returning id`,
    [id, status, code, now],
  );
  return closed.rows.length === 1;
}

/**
 * Move the order to what its refunds add up to: everything back, refunded;
 * some back, partly refunded. Only through the transition table, so a move it
 * does not allow (a refund for an order never paid) is reported, not made.
 * Call with the order locked.
 */
export async function recomputeOrderRefunds(
  runner: QueryRunner,
  orderId: string,
  now: Date,
): Promise<OrderRefundMove> {
  const order = await lockOrder(runner, orderId);
  if (order === null) return "unchanged";
  const total = await runner.query<{ total: string | number }>(
    `select coalesce(sum(amount_fils), 0) as total
       from refunds where order_id = $1 and status = 'succeeded'`,
    [orderId],
  );
  const refunded = Number(total.rows[0]?.total ?? 0);
  if (refunded === 0) return "unchanged";
  const target: PaymentStatus =
    refunded >= order.grossAmountFils ? "refunded" : "partially_refunded";

  let moved;
  try {
    moved = transitionPayment(order, target, now);
  } catch (error) {
    if (error instanceof InvalidTransitionError) return "refused";
    throw error;
  }
  if (!moved.changed) return "unchanged";
  await runner.query(`update orders set payment_status = $2, updated_at = $3 where id = $1`, [
    orderId,
    target,
    now,
  ]);
  return target === "refunded" ? "refunded" : "partially_refunded";
}

export interface RefundEventOutcome {
  readonly result: "applied" | "stale" | "unknown_order" | "mismatched";
  readonly orderId: string | null;
  readonly refundId: string | null;
  readonly status: RefundStatus | null;
  readonly orderMove: OrderRefundMove;
}

const FINAL: ReadonlySet<string> = new Set(["succeeded", "failed", "canceled"]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether an event may change a row. A newer event always may; an older one
 * never may, so a late `pending` cannot undo a `succeeded`. At the same
 * moment, a final status wins over one still in flight.
 */
function mayApply(
  current: { status: string; lastEventAt: Date | null },
  next: RefundStatus,
  at: Date,
): boolean {
  if (current.lastEventAt === null) return true;
  const was = current.lastEventAt.getTime();
  if (at.getTime() > was) return true;
  if (at.getTime() < was) return false;
  return FINAL.has(next) || !FINAL.has(current.status);
}

/**
 * Apply a refund event to its row and its order. The order is found from our
 * metadata when the refund is ours, and from the payment when it was made in
 * the dashboard. A refund that disagrees with the order about the payment or
 * the currency is refused and changes nothing.
 */
export async function applyRefundEvent(
  runner: QueryRunner,
  event: RefundEvent,
  now: Date,
): Promise<RefundEventOutcome> {
  const none = (result: RefundEventOutcome["result"], orderId: string | null = null) =>
    ({ result, orderId, refundId: null, status: null, orderMove: "unchanged" }) as const;

  // Metadata is external input: an id that is not a UUID would fail the query and be retried forever.
  const refundRowId =
    event.refundRowId !== null && UUID_PATTERN.test(event.refundRowId) ? event.refundRowId : null;
  let orderId = event.orderId !== null && UUID_PATTERN.test(event.orderId) ? event.orderId : null;
  if (orderId === null && event.paymentIntentId !== null) {
    const found = await runner.query<{ id: string }>(
      `select id from orders where stripe_payment_intent_id = $1`,
      [event.paymentIntentId],
    );
    orderId = found.rows.length === 1 ? found.rows[0]!.id : null;
  }
  if (orderId === null) return none("unknown_order");

  const order = await lockOrder(runner, orderId);
  if (order === null) return none("unknown_order", orderId);
  if (
    event.paymentIntentId === null ||
    order.stripePaymentIntentId !== event.paymentIntentId ||
    order.currency !== event.currency
  ) {
    return none("mismatched", orderId);
  }

  const existing = await runner.query<{
    id: string;
    order_id: string;
    status: string;
    provider_refund_id: string | null;
    last_event_at: Date | null;
  }>(
    `select id, order_id, status, provider_refund_id, last_event_at from refunds
      where provider_refund_id = $1
         or ($2::uuid is not null and id = $2::uuid and provider_refund_id is null)
      order by (provider_refund_id = $1) desc nulls last
      limit 1`,
    [event.providerRefundId, refundRowId],
  );
  let row = existing.rows[0];
  if (row && row.order_id !== orderId) return none("mismatched", orderId);

  if (!row) {
    const inserted = await runner.query<{
      id: string;
      order_id: string;
      status: string;
      provider_refund_id: string | null;
      last_event_at: Date | null;
    }>(
      `insert into refunds (order_id, origin, amount_fils, currency, status, provider_refund_id,
                            last_event_at, created_at, updated_at)
       values ($1, 'processor', $2, $3, $4, $5, $6, $7, $7)
       on conflict (provider_refund_id) do update set updated_at = refunds.updated_at
       returning id, order_id, status, provider_refund_id, last_event_at`,
      [
        orderId,
        event.amountFils,
        event.currency,
        event.status,
        event.providerRefundId,
        event.occurredAt,
        now,
      ],
    );
    row = inserted.rows[0]!;
    if (row.order_id !== orderId) return none("mismatched", orderId);
  } else if (
    !mayApply(
      { status: row.status, lastEventAt: row.last_event_at },
      event.status,
      event.occurredAt,
    )
  ) {
    return { result: "stale", orderId, refundId: row.id, status: null, orderMove: "unchanged" };
  } else if (row.status !== event.status || row.provider_refund_id !== event.providerRefundId) {
    /*
      Written only when something changed. A refund read again and found as
      it was keeps its timestamps, so its age, and the alarm that counts it,
      are not reset by the reading.
    */
    await runner.query(
      `update refunds
          set provider_refund_id = $2, status = $3, last_event_at = $4, lease_until = null,
              next_attempt_at = null, updated_at = $5
        where id = $1`,
      [row.id, event.providerRefundId, event.status, event.occurredAt, now],
    );
  }

  const orderMove = await recomputeOrderRefunds(runner, orderId, now);
  return { result: "applied", orderId, refundId: row.id, status: event.status, orderMove };
}

/**
 * Refunds a person must look at. A failed or cancelled refund counts until
 * the order's succeeded refunds cover it, so one that is finished by hand in
 * the dashboard stops counting, and one that succeeded and then failed keeps
 * counting even though the order already says refunded. Also: refunds still
 * owed a day after they were written (counted from creation, since retries
 * move the row between due and issuing), and refunds whose status has stood
 * at pending for three days.
 */
export async function countRefundsNeedingAttention(
  runner: QueryRunner,
  now: Date,
): Promise<number> {
  const result = await runner.query<{ n: number }>(
    `select count(*)::int as n
       from refunds r join orders o on o.id = r.order_id
      where (r.status in ('failed', 'canceled')
             and (select coalesce(sum(s.amount_fils), 0) from refunds s
                   where s.order_id = r.order_id and s.status = 'succeeded') < o.gross_amount_fils)
         or (r.status in ('due', 'issuing') and r.created_at < $1::timestamptz - interval '1 day')
         or (r.status = 'pending' and r.status_changed_at < $1::timestamptz - interval '3 days')`,
    [now],
  );
  return result.rows[0]?.n ?? 0;
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
