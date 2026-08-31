import type { QueryRunner } from "./db";
import { randomUUID } from "node:crypto";
import type { Order } from "@/domain/booking/order";
import { createBooking } from "@/domain/booking/booking";

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
 * The booking is written as `awaiting_schedule` with NO times. The chosen slot
 * already exists, once, on the slot hold; the times are attached at settlement
 * from the hold that was actually converted, so the two can never disagree.
 * See the note at the insert itself.
 *
 * (This paragraph previously said the opposite - it described the behaviour
 * before the booking was moved onto the domain constructor, and was left
 * behind when the code changed. Two adjacent comments asserting opposite
 * invariants about the payment path is how a later change gets corrected in
 * the wrong direction.)
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

  /*
    Built by the domain rather than assembled in SQL. `createBooking` is where
    the rules live - sequence must be 1 or 2, a timezone is required - and a
    hand-written INSERT enforces none of them. This module used to write the
    row directly, which is how the whole Booking aggregate drifted out of the
    call graph while keeping its tests green.

    It is born with NO TIMES and that is deliberate. The chosen slot already
    exists, once, on the slot hold; copying it onto the booking before anybody
    has paid would create a second place for the same fact to live and disagree
    from. The times are attached when payment settles, from the hold that was
    actually converted.
  */
  const booking = createBooking({
    id: randomUUID(),
    orderId: o.id,
    sessionSlug: input.sessionSlug,
    sequence: 1,
    customerTimezone: input.customerTimezone,
    now: o.createdAt,
  });

  await runner.query(
    `insert into bookings (
       id, order_id, session_slug, sequence, status,
       scheduled_start, scheduled_end, customer_timezone,
       meeting_provider, created_at, updated_at
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      booking.id,
      booking.orderId,
      booking.sessionSlug,
      booking.sequence,
      booking.status,
      booking.scheduledStart,
      booking.scheduledEnd,
      booking.customerTimezone,
      booking.meetingProvider,
      booking.createdAt,
      booking.updatedAt,
    ],
  );

  const bookingId = booking.id;

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
