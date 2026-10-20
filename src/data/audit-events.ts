import type { QueryRunner } from "./db";
import type { AuditEvent } from "@/lib/audit";

/**
 * Writing the audit trail to the database.
 *
 * Kept apart from `lib/audit` so the vocabulary and the call sites do not
 * depend on a database being reachable, and so this can be tested against
 * real SQL rather than a mock.
 */

/** The actor, flattened into two columns so the kind can be filtered without parsing. */
function actorColumns(actor: AuditEvent["actor"]): { kind: string; id: string | null } {
  switch (actor.kind) {
    case "customer":
      return { kind: "customer", id: actor.customerId };
    case "admin":
      return { kind: "admin", id: actor.adminId };
    case "provider":
      return { kind: "provider", id: actor.provider };
    case "system":
      return { kind: "system", id: actor.process };
  }
}

export async function insertAuditEvent(runner: QueryRunner, event: AuditEvent): Promise<void> {
  const actor = actorColumns(event.actor);

  await runner.query(
    `insert into audit_events (action, actor_kind, actor_id, subject, metadata, occurred_at)
     values ($1, $2, $3, $4, $5, $6)`,
    [
      event.action,
      actor.kind,
      actor.id,
      event.subject,
      event.metadata === undefined ? null : JSON.stringify(event.metadata),
      new Date(event.occurredAt),
    ],
  );
}

/**
 * Orders that have been PAID but whose session was never scheduled.
 *
 * The one state in this system that needs a human: the money is ours, the
 * customer is expecting a session, and they appear in no calendar. It was
 * previously detectable only by reading a single `console.error` line on the
 * host's stdout, which means in practice it was not detectable at all.
 *
 * Listed with ids, the session and the amount only - what the desk alert needs
 * to point a person at the payment - and never anything about the customer:
 * the caller is a scheduled job, and nothing on a timer reads customer records.
 */
export interface PaidButUnscheduled {
  readonly orderId: string;
  /** Null when settlement never wrote the booking row. */
  readonly bookingId: string | null;
  readonly sessionSlug: string | null;
  readonly amountFils: number;
  readonly paymentIntentId: string | null;
  /** Only a fully paid order can be given a new time from a link; a part-refunded one is by hand. */
  readonly fullyPaid: boolean;
  /**
   * The order has had a dispute, now won. Its customer is not sent a link by
   * themselves: after a stolen-card dispute the booker may not be the
   * cardholder, so a person decides. (An order whose dispute is not over, or
   * whose money is gone, is not listed at all: the dispute alert has it.)
   */
  readonly disputed: boolean;
  /** When the booking last went back to waiting (its last change); null with no booking. */
  readonly waitingSince: Date | null;
  /** When the customer was sent their choose-a-time link since then; null if not (yet). */
  readonly customerEmailedAt: Date | null;
  /** That email is queued and not sent yet: the desk hears once it has gone, or not. */
  readonly customerEmailPending: boolean;
}

export async function listPaidButUnscheduled(
  runner: QueryRunner,
): Promise<readonly PaidButUnscheduled[]> {
  /*
    A LEFT JOIN, and the difference matters.

    An inner join counted only paid orders that HAVE a booking waiting. An
    order with no booking row at all produced no row, so the count stayed zero
    and the alarm never fired - and that is a reachable state: settlement
    converts the hold before loading the booking, so a missing booking leaves
    the slot permanently blocked, the money taken, and nothing pointing at it.
    The one case with no other trace was the one the alarm could not see.
  */
  const result = await runner.query<{
    order_id: string;
    booking_id: string | null;
    session_slug: string | null;
    gross_amount_fils: string | number;
    stripe_payment_intent_id: string | null;
    payment_status: string;
    disputed: boolean;
    waiting_since: Date | null;
    email_status: string | null;
    email_sent_at: Date | null;
  }>(
    // One row per order: the desk alert is keyed by it.
    `select distinct on (o.id)
            o.id as order_id, b.id as booking_id, o.session_slug, o.gross_amount_fils,
            o.stripe_payment_intent_id, o.payment_status,
            (exists (select 1 from payment_disputes d where d.order_id = o.id)
             or exists (select 1 from fraud_warnings f where f.order_id = o.id)) as disputed,
            b.updated_at as waiting_since, cl.status as email_status, cl.sent_at as email_sent_at
       from orders o
       left join bookings b on b.order_id = o.id
       left join communication_log cl
              on cl.booking_id = b.id and cl.template_key = 'choose_new_time'
      -- Partly refunded still counts: a goodwill part-refund leaves the
      -- customer owed a session. Only a full refund settles it.
      where o.payment_status in ('paid', 'partially_refunded')
        and (b.id is null or b.status = 'awaiting_schedule')
        and not exists (select 1 from payment_disputes d
                         where d.order_id = o.id and d.status not in ('won', 'warning_closed'))
      order by o.id, b.sequence`,
  );
  return result.rows.map((row) => ({
    orderId: row.order_id,
    bookingId: row.booking_id,
    sessionSlug: row.session_slug,
    amountFils: Number(row.gross_amount_fils),
    paymentIntentId: row.stripe_payment_intent_id,
    fullyPaid: row.payment_status === "paid",
    disputed: row.disputed,
    waitingSince: row.waiting_since,
    customerEmailedAt:
      row.email_status === "sent" &&
      row.email_sent_at !== null &&
      row.waiting_since !== null &&
      row.email_sent_at >= row.waiting_since
        ? row.email_sent_at
        : null,
    customerEmailPending: row.email_status === "queued",
  }));
}
