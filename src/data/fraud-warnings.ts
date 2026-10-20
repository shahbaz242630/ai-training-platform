import type { QueryRunner } from "./db";
import { insertAuditEvent } from "./audit-events";
import { cancelOpenBooking } from "./booking-cancellation";
import { lockOrder } from "./settlement";
import { FRAUD_CANCEL_LEAD_MINUTES } from "@/domain/payments/dispute-policy";
import type { FraudWarningEvent } from "@/domain/payments/provider";
import { addMinutes } from "@/lib/time";

/**
 * Early fraud warnings (audit s104 PAY-4; founder, s104: refund automatically
 * and tell the desk).
 *
 * A warning on a paid order whose open sessions are ALL at least two hours
 * away cancels them and queues a full refund, which the sweep sends: the
 * cardholder gets their money back before they have to dispute it, and the
 * session does not go to whoever used the card. Two hours, as for a
 * stolen-card dispute: inside that a cancellation would reach nobody in time.
 *
 * Anything less clear is a person's decision, never guessed: a session inside
 * two hours or already delivered (a partial refund would be a judgement), an
 * order not paid or already partly refunded, a warning the processor no
 * longer calls actionable, a payment no order of ours has.
 *
 * No customer email in either case, as for a stolen-card dispute: the person
 * who booked may not be the cardholder. The desk is told every time.
 */

export type FraudWarningOutcome = "refund_queued" | "desk_decides" | "unknown_order";

export interface RecordedFraudWarning {
  readonly id: string;
  readonly orderId: string | null;
  readonly outcome: FraudWarningOutcome;
  /** False when this warning was already stored: nothing was done again. */
  readonly isNew: boolean;
  readonly cancelledBookings: readonly string[];
}

/** The statuses a session is still to come in (supabase booking_core). */
const OPEN: ReadonlySet<string> = new Set(["awaiting_schedule", "scheduled", "confirmed"]);

/** Store the warning and act on it, once. Call inside a transaction. */
export async function recordFraudWarning(
  runner: QueryRunner,
  event: FraudWarningEvent,
  now: Date,
): Promise<RecordedFraudWarning> {
  const existing = await findWarning(runner, event.providerWarningId);
  if (existing !== null) return { ...existing, isNew: false, cancelledBookings: [] };

  const orderId = await orderForPayment(runner, event.paymentIntentId);
  const order = orderId === null ? null : await lockOrder(runner, orderId);
  const decision =
    order === null
      ? { outcome: "unknown_order" as const, cancellable: [] }
      : await decide(runner, order.id, order.paymentStatus, event.actionable, now);

  /*
    On conflict: two deliveries of one warning under different event ids can
    both pass the check above; the second, having waited on the order lock,
    stores nothing and acts on nothing (review s104).
  */
  const inserted = await runner.query<{ id: string }>(
    `insert into fraud_warnings (provider_warning_id, payment_intent_id, order_id, fraud_type,
                                 actionable, outcome, received_at, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $7)
     on conflict (provider_warning_id) do nothing
     returning id`,
    [
      event.providerWarningId,
      event.paymentIntentId,
      order?.id ?? null,
      event.fraudType,
      event.actionable,
      decision.outcome,
      now,
    ],
  );
  const id = inserted.rows[0]?.id;
  if (!id) {
    const stored = await findWarning(runner, event.providerWarningId);
    if (stored === null) throw new Error("a fraud warning vanished as it was stored");
    return { ...stored, isNew: false, cancelledBookings: [] };
  }

  const cancelled: string[] = [];
  if (decision.outcome === "refund_queued" && order !== null) {
    for (const bookingId of decision.cancellable) {
      if (!(await cancelOpenBooking(runner, bookingId, now))) continue;
      cancelled.push(bookingId);
      await insertAuditEvent(runner, {
        action: "booking.cancelled",
        actor: { kind: "provider", provider: "stripe" },
        subject: `booking:${bookingId}`,
        metadata: { orderId: order.id, cause: "early_fraud_warning", fraudWarningId: id },
        occurredAt: now.toISOString(),
      });
    }
    // The full amount, in the order's currency; the sweep sends it (data/refund-issuer.ts).
    await runner.query(
      `insert into refunds (order_id, fraud_warning_id, origin, amount_fils, currency, status,
                            created_at, updated_at)
       values ($1, $2, 'fraud_warning', $3, $4, 'due', $5, $5)`,
      [order.id, id, order.grossAmountFils, order.currency, now],
    );
  }

  return {
    id,
    orderId: order?.id ?? null,
    outcome: decision.outcome,
    isNew: true,
    cancelledBookings: cancelled,
  };
}

async function decide(
  runner: QueryRunner,
  orderId: string,
  paymentStatus: string,
  actionable: boolean,
  now: Date,
): Promise<{ outcome: "refund_queued" | "desk_decides"; cancellable: readonly string[] }> {
  const desk = { outcome: "desk_decides" as const, cancellable: [] };
  if (!actionable || paymentStatus !== "paid") return desk;

  /*
    Money already on its way back, or a dispute already here, is a person's
    to weigh (review s104). An order stays "paid" until a refund succeeds, so
    a second full refund would be queued, refused by Stripe, and raise a
    "refund by hand" alarm that invites a person to refund twice.
  */
  const busy = await runner.query<{ busy: boolean }>(
    `select exists (select 1 from refunds where order_id = $1
                     and status in ('due', 'issuing', 'pending', 'succeeded'))
         or exists (select 1 from payment_disputes where order_id = $1) as busy`,
    [orderId],
  );
  if (busy.rows[0]?.busy) return desk;

  // Every session on the order: one delivered, under way or close means a person decides.
  const sessions = await runner.query<{ id: string; status: string; scheduled_start: Date | null }>(
    `select id, status, scheduled_start from bookings where order_id = $1 order by sequence`,
    [orderId],
  );
  /*
    Nothing marks a session completed yet (audit s104 PAY-6), so a session in
    the past is still "confirmed": the time check is what catches it.
  */
  const notBefore = addMinutes(now, FRAUD_CANCEL_LEAD_MINUTES);
  const open = sessions.rows.filter((s) => OPEN.has(s.status));
  const allFarEnough = open.every(
    (s) => s.scheduled_start === null || s.scheduled_start.getTime() > notBefore.getTime(),
  );
  const anyDelivered = sessions.rows.some((s) => !OPEN.has(s.status) && s.status !== "cancelled");
  if (open.length === 0 || !allFarEnough || anyDelivered) return desk;
  return { outcome: "refund_queued", cancellable: open.map((s) => s.id) };
}

async function findWarning(
  runner: QueryRunner,
  providerWarningId: string,
): Promise<{ id: string; orderId: string | null; outcome: FraudWarningOutcome } | null> {
  const result = await runner.query<{ id: string; order_id: string | null; outcome: string }>(
    `select id, order_id, outcome from fraud_warnings where provider_warning_id = $1`,
    [providerWarningId],
  );
  const row = result.rows[0];
  return row
    ? { id: row.id, orderId: row.order_id, outcome: row.outcome as FraudWarningOutcome }
    : null;
}

async function orderForPayment(
  runner: QueryRunner,
  paymentIntentId: string | null,
): Promise<string | null> {
  if (paymentIntentId === null) return null;
  const result = await runner.query<{ id: string }>(
    `select id from orders where stripe_payment_intent_id = $1`,
    [paymentIntentId],
  );
  return result.rows[0]?.id ?? null;
}

/**
 * A fraud warning the desk is told about. Ids and facts only.
 *
 * Refunded automatically: told once (present for a day), so the desk knows
 * why a session vanished and money went back. If the refund itself fails,
 * the refund alarm takes over.
 *
 * For a person to decide: present while the order is not refunded in full,
 * for at most two weeks; by then it is a dispute or it is over.
 */
export interface FraudWarningForDesk {
  readonly id: string;
  readonly outcome: FraudWarningOutcome;
  readonly fraudType: string;
  readonly receivedAt: Date;
  readonly orderId: string | null;
  readonly grossAmountFils: number | null;
  readonly bookingId: string | null;
  readonly sessionSlug: string | null;
  readonly sessionStart: Date | null;
}

const TOLD_ONCE_HOURS = 24;
const DECIDE_DAYS = 14;

export async function listFraudWarningsForDesk(
  runner: QueryRunner,
  now: Date,
): Promise<readonly FraudWarningForDesk[]> {
  const result = await runner.query<{
    id: string;
    outcome: FraudWarningOutcome;
    fraud_type: string;
    received_at: Date;
    order_id: string | null;
    gross_amount_fils: string | number | null;
    booking_id: string | null;
    session_slug: string | null;
    scheduled_start: Date | null;
  }>(
    `select distinct on (f.id)
            f.id, f.outcome, f.fraud_type, f.received_at, f.order_id, o.gross_amount_fils,
            b.id as booking_id, b.session_slug, b.scheduled_start
       from fraud_warnings f
       left join orders o on o.id = f.order_id
       left join bookings b on b.order_id = f.order_id
      where (f.outcome = 'refund_queued'
             and f.received_at > $1::timestamptz - make_interval(hours => ${TOLD_ONCE_HOURS}))
         or (f.outcome <> 'refund_queued'
             and f.received_at > $1::timestamptz - make_interval(days => ${DECIDE_DAYS})
             and (o.id is null or o.payment_status <> 'refunded'))
      order by f.id, b.sequence`,
    [now],
  );
  return result.rows.map((row) => ({
    id: row.id,
    outcome: row.outcome,
    fraudType: row.fraud_type,
    receivedAt: row.received_at,
    orderId: row.order_id,
    grossAmountFils: row.gross_amount_fils === null ? null : Number(row.gross_amount_fils),
    bookingId: row.booking_id,
    sessionSlug: row.session_slug,
    sessionStart: row.scheduled_start,
  }));
}

/**
 * Give a warning that arrived before its order's payment its order, now that
 * the order has the payment (review s104). Rare (warnings come days later),
 * so nothing is decided automatically here: the desk decides, and the order
 * can no longer be moved online. In the settlement's own transaction.
 */
export async function linkFraudWarningsAtSettlement(
  runner: QueryRunner,
  orderId: string,
  paymentIntentId: string | null,
): Promise<number> {
  if (paymentIntentId === null) return 0;
  const linked = await runner.query<{ id: string }>(
    `update fraud_warnings set order_id = $1, outcome = 'desk_decides'
      where order_id is null and payment_intent_id = $2
      returning id`,
    [orderId, paymentIntentId],
  );
  return linked.rows.length;
}
