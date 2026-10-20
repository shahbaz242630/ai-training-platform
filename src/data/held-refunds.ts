import type { QueryRunner } from "./db";
import { applyRefundEvent, type RefundEventOutcome } from "./refunds";
import type { RefundEvent, RefundStatus } from "@/domain/payments/provider";

/**
 * Refund events held until their payment is ours (audit s104 PAY-2).
 *
 * A refund made in the dashboard is matched to its order by the payment, and
 * the order has the payment only once it is settled. Stripe does not promise
 * event order, so after an outage a refund can arrive first; it was dropped,
 * and settlement then confirmed a session for money already given back. Now
 * it is held (one row per refund, at its newest event) and applied at
 * settlement through applyRefundEvent, exactly as if it had arrived then.
 */

/** Hold a refund event no order has the payment for yet. Call inside the event's transaction. */
export async function holdRefundEvent(
  runner: QueryRunner,
  event: RefundEvent,
  now: Date,
): Promise<boolean> {
  if (event.paymentIntentId === null || event.amountFils <= 0) return false;
  await runner.query(
    `insert into held_refund_events (provider_refund_id, payment_intent_id, amount_fils, currency,
                                     status, occurred_at, received_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (provider_refund_id) do update
        set amount_fils = excluded.amount_fils, currency = excluded.currency,
            status = excluded.status, occurred_at = excluded.occurred_at
      where excluded.occurred_at > held_refund_events.occurred_at
         or (excluded.occurred_at = held_refund_events.occurred_at
             and (excluded.status in ('succeeded', 'failed', 'canceled')
                  or held_refund_events.status not in ('succeeded', 'failed', 'canceled')))`,
    [
      event.providerRefundId,
      event.paymentIntentId,
      event.amountFils,
      event.currency,
      event.status,
      event.occurredAt,
      now,
    ],
  );
  return true;
}

/**
 * Apply the refunds held for a payment that has just become an order's, in
 * the settlement's transaction, and let them go. Returns what each did.
 */
export async function applyHeldRefunds(
  runner: QueryRunner,
  paymentIntentId: string | null,
  now: Date,
): Promise<readonly RefundEventOutcome[]> {
  if (paymentIntentId === null) return [];
  const held = await runner.query<{
    provider_refund_id: string;
    amount_fils: string | number;
    currency: string;
    status: RefundStatus;
    occurred_at: Date;
  }>(
    `delete from held_refund_events where payment_intent_id = $1
      returning provider_refund_id, amount_fils, currency, status, occurred_at`,
    [paymentIntentId],
  );
  const outcomes: RefundEventOutcome[] = [];
  for (const row of held.rows.toSorted(
    (a, b) => a.occurred_at.getTime() - b.occurred_at.getTime(),
  )) {
    outcomes.push(
      await applyRefundEvent(
        runner,
        {
          kind: "refund",
          eventId: `held:${row.provider_refund_id}`,
          type: "refund.held",
          occurredAt: row.occurred_at,
          ignorable: false,
          orderId: null,
          refundRowId: null,
          providerRefundId: row.provider_refund_id,
          paymentIntentId,
          amountFils: Number(row.amount_fils),
          currency: row.currency,
          status: row.status,
        },
        now,
      ),
    );
  }
  return outcomes;
}
