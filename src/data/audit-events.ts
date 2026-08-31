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
 * Counted rather than listed, because the caller is a scheduled job that
 * should alert on the number and never log customer records on a timer.
 */
export async function countPaidButUnscheduled(runner: QueryRunner): Promise<number> {
  const result = await runner.query<{ n: number }>(
    `select count(*)::int as n
       from orders o
       join bookings b on b.order_id = o.id
      where o.payment_status = 'paid'
        and b.status = 'awaiting_schedule'`,
  );
  return result.rows[0]?.n ?? 0;
}
