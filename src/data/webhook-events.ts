import type { QueryRunner } from "./db";

/**
 * The ledger that makes a repeated delivery harmless.
 *
 * Stripe retries. A delivery that arrives twice must confirm one booking, not
 * two, and must send one email, not two. The unique constraint on
 * (provider, external_event_id) is what makes that guaranteed rather than
 * merely intended - application code that checks and then acts loses the race
 * with its own retry.
 *
 * The row holds an event id, a type and a timestamp. No payment details, no
 * customer, nothing worth reading if this table ever leaked.
 */

export interface EventClaim {
  /** True only for the first delivery. A duplicate gets false and must do nothing. */
  readonly isFirstDelivery: boolean;
}

/**
 * Claim an event before acting on it.
 *
 * ORDER MATTERS AND IT IS THIS WAY ROUND ON PURPOSE. The claim is written
 * FIRST, inside the same transaction that then acts. Acting first and
 * recording second means a crash between the two turns the next retry into a
 * second confirmed booking - which is the exact failure this table exists to
 * prevent.
 *
 * `on conflict do nothing` rather than a select-then-insert: two deliveries of
 * the same event can arrive together, and check-then-act would let both
 * through.
 */
export async function claimWebhookEvent(
  runner: QueryRunner,
  externalEventId: string,
  eventType: string,
): Promise<EventClaim> {
  const result = await runner.query<{ id: string }>(
    `insert into webhook_events (provider, external_event_id, event_type)
     values ('stripe', $1, $2)
     on conflict (provider, external_event_id) do nothing
     returning id`,
    [externalEventId, eventType],
  );
  return { isFirstDelivery: result.rows.length > 0 };
}

/**
 * Mark the claim as fully handled.
 *
 * Separate from the claim so the two are distinguishable afterwards: a row
 * with no `processed_at` is a delivery we accepted and then failed to finish,
 * which is exactly what somebody investigating needs to be able to find.
 */
export async function markWebhookProcessed(
  runner: QueryRunner,
  externalEventId: string,
): Promise<void> {
  await runner.query(
    `update webhook_events set processed_at = now()
      where provider = 'stripe' and external_event_id = $1`,
    [externalEventId],
  );
}
