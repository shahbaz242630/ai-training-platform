import type { QueryRunner } from "./db";
import type { Order } from "@/domain/booking/order";

/**
 * Writing an order, its booking, and the claim on the time it needs.
 *
 * All three in ONE transaction, deliberately. An order without its booking is
 * a customer charged for a session that does not exist; a booking whose slot
 * hold was never linked is a session nothing is protecting on the calendar.
 * Partial application of this is the failure mode the whole design is trying
 * to avoid, and a transaction is the only thing that actually prevents it.
 */

/**
 * The intake must belong to the customer.
 *
 * This is what makes the lead cookie hold up. A forged pair has to get BOTH
 * ids right AND their relationship, rather than one lucky guess - and a
 * mismatch means the browser sent something it should not have, so the answer
 * is to refuse rather than to repair.
 */
export async function leadBelongsTogether(
  runner: QueryRunner,
  customerId: string,
  intakeId: string,
): Promise<boolean> {
  const result = await runner.query<{ ok: boolean }>(
    `select exists (
       select 1 from intakes where id = $1 and customer_id = $2
     ) as ok`,
    [intakeId, customerId],
  );
  return result.rows[0]?.ok === true;
}

/** The attribution row for this browser, if it has one. Never fails a checkout. */
export async function attributionIdForSession(
  runner: QueryRunner,
  anonymousSessionId: string | null,
): Promise<string | null> {
  if (anonymousSessionId === null) return null;
  const result = await runner.query<{ id: string }>(
    `select id from attributions where anonymous_session_id = $1`,
    [anonymousSessionId],
  );
  return result.rows[0]?.id ?? null;
}

export interface PersistOrderInput {
  readonly order: Order;
  /** The session being booked, and when. Both UTC. */
  readonly sessionSlug: string;
  readonly slotStart: Date;
  readonly slotEnd: Date;
  readonly customerTimezone: string;
  /** The claim on the slot, which this order now owns. */
  readonly slotHoldId: string;
}

/**
 * Persist a pending order, the booking it will become, and the link from the
 * slot hold back to the order.
 *
 * The booking is written as `awaiting_schedule` WITH its times. That is not a
 * contradiction: we know when the session would be, and we do not yet know
 * that it is happening. Only a verified payment moves it on. Writing it as
 * `scheduled` here would mean the database said a session existed before
 * anybody had paid for it.
 */
export async function persistPendingOrder(
  runner: QueryRunner,
  input: PersistOrderInput,
): Promise<{ readonly orderId: string; readonly bookingId: string }> {
  const o = input.order;

  await runner.query(
    `insert into orders (
       id, customer_id, order_type, session_slug, pathway_slug,
       gross_amount_fils, currency, tax_treatment, tax_rate_basis_points,
       payment_status, attribution_id, intake_id, created_at, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      o.id,
      o.customerId,
      o.orderType,
      o.sessionSlug,
      o.pathwaySlug,
      o.grossAmountFils,
      o.currency,
      o.taxTreatment,
      o.taxRateBasisPoints,
      // Always `pending` on the way in. There is no path that writes an order
      // as paid, because an order that begins life paid is one nobody
      // verified a webhook for.
      o.paymentStatus,
      o.attributionId,
      o.intakeId,
      o.createdAt,
      o.updatedAt,
    ],
  );

  const booking = await runner.query<{ id: string }>(
    `insert into bookings (
       order_id, session_slug, sequence, status,
       scheduled_start, scheduled_end, customer_timezone
     ) values ($1, $2, 1, 'awaiting_schedule', $3, $4, $5)
     returning id`,
    [o.id, input.sessionSlug, input.slotStart, input.slotEnd, input.customerTimezone],
  );

  const bookingId = booking.rows[0]?.id;
  if (!bookingId) throw new Error("persistPendingOrder stored no booking, which is impossible");

  /*
    The hold is claimed by this order, and only if it is still live. A hold
    that expired while the customer was deciding must not be silently adopted:
    the update matches nothing, we notice, and the whole transaction is undone
    rather than producing an order for a slot somebody else may already hold.
  */
  const claimed = await runner.query<{ id: string }>(
    `update slot_holds
        set order_id = $1
      where id = $2 and status = 'held' and expires_at > now()
      returning id`,
    [o.id, input.slotHoldId],
  );

  if (claimed.rows.length === 0) {
    throw new SlotHoldNoLongerLiveError(input.slotHoldId);
  }

  return { orderId: o.id, bookingId };
}

/** The hold expired or was taken between being created and being paid for. */
export class SlotHoldNoLongerLiveError extends Error {
  constructor(slotHoldId: string) {
    super(`Slot hold ${slotHoldId} is no longer live, so no order was created`);
    this.name = "SlotHoldNoLongerLiveError";
  }
}

/** Record which Stripe session belongs to this order, once Stripe has issued one. */
export async function attachCheckoutSession(
  runner: QueryRunner,
  orderId: string,
  checkoutSessionId: string,
): Promise<void> {
  await runner.query(
    `update orders set stripe_checkout_session_id = $2, updated_at = now() where id = $1`,
    [orderId, checkoutSessionId],
  );
}
