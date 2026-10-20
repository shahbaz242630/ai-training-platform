import type { QueryRunner } from "./db";
import { insertAuditEvent } from "./audit-events";
import { cancelOpenBooking } from "./booking-cancellation";
import { lockOrder } from "./settlement";
import {
  CLOSED_DISPUTE_STATUSES_SQL,
  FRAUD_CANCEL_LEAD_MINUTES,
  FRAUD_REASON,
  disputeCancels,
  disputeStage,
} from "@/domain/payments/dispute-policy";
import type { DisputeSnapshot } from "@/domain/payments/provider";
import { addMinutes } from "@/lib/time";

/**
 * Disputes: storing what the processor says about one, and what it does to
 * the sessions on its order (rules in domain/payments/dispute-policy.ts).
 *
 * Effects are worked out from the stored state, never from "what just
 * changed", so applying them twice, or after events arrived out of order,
 * gives the same answer. The webhook applies them as soon as a dispute is
 * stored; the sweep applies them again for any order that still has work,
 * which covers a dispute that arrived before its order's own payment.
 */

/** The statuses that can still move to another (inquiry, then chargeback, then a result). */
const RANK: Readonly<Record<string, number>> = {
  warning_needs_response: 1,
  warning_under_review: 2,
  needs_response: 3,
  under_review: 4,
  warning_closed: 5,
  won: 5,
  lost: 5,
  prevented: 5,
};

/**
 * Whether a newer read may replace the stored status. A read taken a moment
 * before another but stored after it must not move the dispute backwards, so
 * a status only moves forward. One exception: Stripe can turn a loss into a
 * win late. A status this code does not know always applies: it is newer
 * than anything we know, and the desk is told about it.
 */
export function mayReplaceStatus(stored: string, next: string): boolean {
  const from = RANK[stored];
  const to = RANK[next];
  if (from === undefined || to === undefined) return true;
  if (stored === "lost" && next === "won") return true;
  if (from === 5) return stored === next;
  return to >= from;
}

export interface RecordedDispute {
  readonly id: string;
  readonly orderId: string | null;
  readonly status: string;
  /** False when the read was older than what was stored and nothing changed. */
  readonly applied: boolean;
}

/** Store a dispute as the processor has it now. Call inside the webhook's transaction. */
export async function recordDispute(
  runner: QueryRunner,
  dispute: DisputeSnapshot,
  now: Date,
): Promise<RecordedDispute> {
  /*
    One delivery at a time per dispute. The order lock below does this when the
    order is known; a dispute on a payment we cannot find yet has no order to
    lock, and two deliveries would otherwise both write, the older read last.
    Taken before the order lock, and nothing else takes it, so no cycle.
  */
  await runner.query(`select pg_advisory_xact_lock(hashtext($1))`, [dispute.providerDisputeId]);
  let orderId: string | null = null;
  if (dispute.paymentIntentId !== null) {
    const found = await runner.query<{ id: string }>(
      `select id from orders where stripe_payment_intent_id = $1`,
      [dispute.paymentIntentId],
    );
    orderId = found.rows.length === 1 ? found.rows[0]!.id : null;
  }
  // The order first, the lock order every money path takes.
  if (orderId !== null) await lockOrder(runner, orderId);

  const stored = await runner.query<{ id: string; order_id: string | null; status: string }>(
    `select id, order_id, status from payment_disputes where provider_dispute_id = $1 for update`,
    [dispute.providerDisputeId],
  );
  const existing = stored.rows[0];
  if (existing && !mayReplaceStatus(existing.status, dispute.status)) {
    return { id: existing.id, orderId: existing.order_id, status: existing.status, applied: false };
  }

  const written = await runner.query<{ id: string; order_id: string | null; status: string }>(
    `insert into payment_disputes (provider_dispute_id, order_id, payment_intent_id, amount_minor,
                                   currency, reason, status, evidence_due_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
     on conflict (provider_dispute_id) do update
        set order_id = coalesce(payment_disputes.order_id, excluded.order_id),
            payment_intent_id = excluded.payment_intent_id,
            amount_minor = excluded.amount_minor,
            currency = excluded.currency,
            reason = excluded.reason,
            status = excluded.status,
            evidence_due_by = excluded.evidence_due_by,
            updated_at = excluded.updated_at
     returning id, order_id, status`,
    [
      dispute.providerDisputeId,
      orderId,
      dispute.paymentIntentId,
      dispute.amountMinor,
      dispute.currency,
      // The columns are bounded; a processor word longer than that is not one we know.
      dispute.reason.slice(0, 60),
      dispute.status.slice(0, 60),
      dispute.evidenceDueBy,
      now,
    ],
  );
  const row = written.rows[0]!;
  return { id: row.id, orderId: row.order_id, status: row.status, applied: true };
}

/**
 * Cancel the sessions a dispute on this order says must not go ahead. Only
 * sessions still to come: one that has started or taken place is evidence
 * and is left exactly as it is. No email to the customer: the desk writes,
 * since with a stolen card the person who booked may not be the cardholder.
 * Returns the bookings cancelled. Call inside a transaction.
 */
export async function applyDisputeEffects(
  runner: QueryRunner,
  orderId: string,
  now: Date,
): Promise<readonly string[]> {
  if ((await lockOrder(runner, orderId)) === null) return [];
  const disputes = await runner.query<{ status: string; reason: string }>(
    `select status, reason from payment_disputes where order_id = $1`,
    [orderId],
  );
  const effects = disputes.rows.map((d) => disputeCancels(d));
  const cause = effects.includes("money_gone")
    ? "money_gone"
    : effects.includes("fraud")
      ? "fraud"
      : null;
  if (cause === null) return [];

  const notBefore = cause === "fraud" ? addMinutes(now, FRAUD_CANCEL_LEAD_MINUTES) : now;
  const open = await runner.query<{ id: string }>(
    `select id from bookings
      where order_id = $1 and status in ('awaiting_schedule', 'scheduled', 'confirmed')
        and (scheduled_start is null or scheduled_start > $2)
      order by sequence`,
    [orderId, notBefore],
  );
  const cancelled: string[] = [];
  for (const { id } of open.rows) {
    if (!(await cancelOpenBooking(runner, id, now))) continue;
    cancelled.push(id);
    await insertAuditEvent(runner, {
      action: "booking.cancelled",
      actor: { kind: "provider", provider: "stripe" },
      subject: `booking:${id}`,
      metadata: { orderId, cause: cause === "fraud" ? "dispute_fraud" : "dispute_money_gone" },
      occurredAt: now.toISOString(),
    });
  }
  return cancelled;
}

/**
 * Give a dispute that arrived before its order's payment its order, now that
 * the order has the payment. Returns the orders linked.
 */
export async function linkUnlinkedDisputes(
  runner: QueryRunner,
  now: Date,
): Promise<readonly string[]> {
  const linked = await runner.query<{ order_id: string }>(
    `update payment_disputes d
        set order_id = o.id, updated_at = $1
       from orders o
      where d.order_id is null and d.payment_intent_id is not null
        and o.stripe_payment_intent_id = d.payment_intent_id
      returning d.order_id`,
    [now],
  );
  return [...new Set(linked.rows.map((r) => r.order_id))];
}

/**
 * Orders with a dispute that cancels and a session it would still cancel: the
 * sweep's work. The same lead time as applyDisputeEffects, so a stolen-card
 * session already inside it is not picked, and locked, on every run.
 */
export async function ordersWithDisputeWork(
  runner: QueryRunner,
  now: Date,
): Promise<readonly string[]> {
  const result = await runner.query<{ order_id: string }>(
    `select distinct d.order_id
       from payment_disputes d
       join bookings b on b.order_id = d.order_id
      where b.status in ('awaiting_schedule', 'scheduled', 'confirmed')
        and ((d.status in ('lost', 'prevented')
              and (b.scheduled_start is null or b.scheduled_start > $1))
             or (d.status in ('needs_response', 'under_review') and d.reason = $2
                 and (b.scheduled_start is null or b.scheduled_start > $3)))`,
    [now, FRAUD_REASON, addMinutes(now, FRAUD_CANCEL_LEAD_MINUTES)],
  );
  return result.rows.map((r) => r.order_id);
}

/**
 * Give this order the disputes that arrived before its payment did, and
 * apply what they say, in the settlement's own transaction: a stolen-card
 * dispute that came first must stop the session before its confirmation goes
 * out, not five minutes later. Returns the bookings cancelled.
 */
export async function linkDisputesAtSettlement(
  runner: QueryRunner,
  orderId: string,
  paymentIntentId: string | null,
  now: Date,
): Promise<readonly string[]> {
  if (paymentIntentId === null) return [];
  const linked = await runner.query<{ id: string }>(
    `update payment_disputes set order_id = $1, updated_at = $3
      where order_id is null and payment_intent_id = $2
      returning id`,
    [orderId, paymentIntentId, now],
  );
  if (linked.rows.length === 0) return [];
  return applyDisputeEffects(runner, orderId, now);
}

/**
 * Whether the order's payment has ever been disputed. If so the customer
 * cannot move or choose a time online, even once the dispute is over: after a
 * stolen-card dispute the person holding the link may not be the cardholder,
 * and an inquiry about a stolen card can close without ever cancelling
 * anything. A person rebooks by hand. Disputes are rare; this costs little.
 *
 * An early fraud warning counts too (audit s104 PAY-4): it is the same
 * stolen-card signal, only earlier.
 */
export async function orderHasDispute(runner: QueryRunner, orderId: string): Promise<boolean> {
  const result = await runner.query<{ disputed: boolean }>(
    `select exists (select 1 from payment_disputes where order_id = $1)
         or exists (select 1 from fraud_warnings where order_id = $1) as disputed`,
    [orderId],
  );
  return result.rows[0]?.disputed ?? false;
}

/**
 * A dispute the desk has to hear about, with the evidence on record. Ids and
 * facts only.
 *
 * "respond": waiting for a response, in a status this code does not know, or
 * about a payment we cannot find. Closes once the processor moves it on.
 *
 * "outcome": over, and something a person must follow up: the money is gone
 * (whatever happened to the session), or it was won after it had cancelled a
 * session, so we hold the money and the customer has no session. Shown for a
 * week after the outcome, then it closes by itself.
 */
export interface DisputeForDesk {
  readonly kind: "respond" | "outcome";
  readonly id: string;
  readonly providerDisputeId: string;
  readonly orderId: string | null;
  readonly paymentIntentId: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly reason: string;
  readonly status: string;
  readonly evidenceDueBy: Date | null;
  readonly bookingId: string | null;
  readonly bookingStatus: string | null;
  readonly sessionSlug: string | null;
  readonly sessionStart: Date | null;
  /** A dispute on this order cancelled one of its sessions. */
  readonly sessionCancelledByDispute: boolean;
  readonly termsVersion: string | null;
  readonly termsAcceptedAt: Date | null;
  readonly expressRequest: boolean | null;
  /** Customer emails sent about the booking, oldest first. */
  readonly emailsSent: readonly { readonly templateKey: string; readonly sentAt: Date }[];
  /** Refunds on the order, oldest first: a dispute on money already returned must not be paid twice. */
  readonly refunds: readonly {
    readonly amountFils: number;
    readonly status: string;
    readonly createdAt: Date;
  }[];
}

/** The statuses a dispute ends in. */
const OUTCOME_STATUSES: ReadonlySet<string> = new Set([
  "won",
  "warning_closed",
  "lost",
  "prevented",
]);

/** How long an outcome stays in front of the desk. */
const OUTCOME_DAYS = 7;

const KNOWN_STATUSES =
  "('needs_response', 'warning_needs_response', 'under_review', 'warning_under_review', " +
  "'won', 'warning_closed', 'lost', 'prevented')";

export async function listDisputesForDesk(
  runner: QueryRunner,
  now: Date,
): Promise<readonly DisputeForDesk[]> {
  const result = await runner.query<{
    id: string;
    provider_dispute_id: string;
    order_id: string | null;
    payment_intent_id: string | null;
    amount_minor: string | number;
    currency: string;
    reason: string;
    status: string;
    evidence_due_by: Date | null;
    booking_id: string | null;
    booking_status: string | null;
    session_slug: string | null;
    scheduled_start: Date | null;
    cancelled_by_dispute: boolean;
    terms_version: string | null;
    accepted_at: Date | null;
    express_request: boolean | null;
  }>(
    `with flagged as (
       select d.*,
              exists (select 1 from audit_events a
                        join bookings cb on a.subject = 'booking:' || cb.id
                       where cb.order_id = d.order_id and a.action = 'booking.cancelled'
                         and a.metadata ->> 'cause' like 'dispute%') as cancelled_by_dispute
         from payment_disputes d
     )
     select distinct on (d.id)
            d.id, d.provider_dispute_id, d.order_id, d.payment_intent_id, d.amount_minor,
            d.currency, d.reason, d.status, d.evidence_due_by, d.cancelled_by_dispute,
            b.id as booking_id, b.status as booking_status, b.session_slug, b.scheduled_start,
            c.terms_version, c.accepted_at, c.express_request
       from flagged d
       left join bookings b on b.order_id = d.order_id
       left join booking_consents c on c.order_id = d.order_id
      where d.status in ('needs_response', 'warning_needs_response')
         or d.status not in ${KNOWN_STATUSES}
         or (d.order_id is null and d.status not in ${CLOSED_DISPUTE_STATUSES_SQL})
         or (d.updated_at > $1::timestamptz - interval '${OUTCOME_DAYS} days'
             and (d.status in ('lost', 'prevented')
                  or (d.status in ('won', 'warning_closed') and d.cancelled_by_dispute)))
      order by d.id, b.sequence`,
    [now],
  );
  const bookingIds = result.rows.flatMap((r) => (r.booking_id ? [r.booking_id] : []));
  const orderIds = result.rows.flatMap((r) => (r.order_id ? [r.order_id] : []));
  const sent =
    bookingIds.length === 0
      ? []
      : (
          await runner.query<{ booking_id: string; template_key: string; sent_at: Date }>(
            `select booking_id, template_key, sent_at from communication_log
              where booking_id = any($1) and status = 'sent' and sent_at is not null
              order by sent_at`,
            [bookingIds],
          )
        ).rows;
  const refunds =
    orderIds.length === 0
      ? []
      : (
          await runner.query<{
            order_id: string;
            amount_fils: string | number;
            status: string;
            created_at: Date;
          }>(
            `select order_id, amount_fils, status, created_at from refunds
              where order_id = any($1) order by created_at`,
            [orderIds],
          )
        ).rows;
  return result.rows.map((r) => ({
    kind: OUTCOME_STATUSES.has(r.status) ? "outcome" : "respond",
    id: r.id,
    providerDisputeId: r.provider_dispute_id,
    orderId: r.order_id,
    paymentIntentId: r.payment_intent_id,
    amountMinor: Number(r.amount_minor),
    currency: r.currency,
    reason: r.reason,
    status: r.status,
    evidenceDueBy: r.evidence_due_by,
    bookingId: r.booking_id,
    bookingStatus: r.booking_status,
    sessionSlug: r.session_slug,
    sessionStart: r.scheduled_start,
    sessionCancelledByDispute: r.cancelled_by_dispute,
    termsVersion: r.terms_version,
    termsAcceptedAt: r.accepted_at,
    expressRequest: r.express_request,
    emailsSent: sent
      .filter((x) => x.booking_id === r.booking_id)
      .map((x) => ({ templateKey: x.template_key, sentAt: x.sent_at })),
    refunds: refunds
      .filter((x) => x.order_id === r.order_id)
      .map((x) => ({
        amountFils: Number(x.amount_fils),
        status: x.status,
        createdAt: x.created_at,
      })),
  }));
}

/** For the desk email: which kind of dispute this is. */
export function deskStage(
  status: string,
): "inquiry" | "chargeback" | "won" | "money_gone" | "unknown" {
  return disputeStage(status);
}
