import type { QueryRunner } from "./db";
import { promoteIntakeToCustomer } from "./customers";
import { transitionPayment, type Order, type PaymentStatus } from "@/domain/booking/order";
import { InvalidTransitionError } from "@/domain/booking/transitions";
import { scheduleBooking, type Booking, type BookingStatus } from "@/domain/booking/booking";

/**
 * What a verified payment event does to an order, its booking and its slot.
 *
 * Every state change here goes through the domain transition tables rather
 * than a bare UPDATE. In a system that takes money and books a calendar, an
 * accidental state change is a customer charged twice or left without the
 * session they paid for - so the permitted moves stay readable in one place
 * and a move that is not in the table cannot happen by accident.
 */

/** What actually happened, so the caller can report it honestly. */
export type SettlementOutcome =
  /** Money in, slot secured, booking scheduled. The normal path. */
  | "settled"
  /** Already done. A duplicate delivery, or a replay. Nothing changed. */
  | "already_settled"
  /**
   * PAID, BUT THE SLOT WAS GONE. Recoverable and must be alerted, never
   * silent: the order stays paid, the booking waits to be rescheduled by
   * hand, and nobody is charged again.
   */
  | "paid_without_slot"
  /** The payment failed or the session expired. The slot goes back. */
  | "released"
  /** We have never heard of this order. */
  | "unknown_order"
  /**
   * The state machine refused the move - a success for a refunded order, or a
   * failure for one already paid. A genuine anomaly, and it must be ALERTED,
   * but it is not something a retry can fix, so the caller still acknowledges
   * the delivery rather than leaving the processor retrying forever.
   */
  | "refused"
  /**
   * The event does not belong to this order, or does not agree with it about
   * how much was paid. Never settled, always alerted.
   */
  | "mismatched";

interface OrderRow {
  readonly id: string;
  readonly customer_id: string;
  readonly order_type: "single" | "pathway";
  readonly session_slug: string | null;
  readonly pathway_slug: string | null;
  readonly gross_amount_fils: string;
  readonly currency: "AED";
  readonly tax_treatment: "inclusive";
  readonly tax_rate_basis_points: number;
  readonly payment_status: PaymentStatus;
  readonly stripe_checkout_session_id: string | null;
  readonly stripe_payment_intent_id: string | null;
  readonly attribution_id: string | null;
  readonly intake_id: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    customerId: row.customer_id,
    orderType: row.order_type,
    sessionSlug: row.session_slug,
    pathwaySlug: row.pathway_slug,
    // bigint arrives as a string from the driver. Parsed explicitly rather
    // than coerced, because a silently wrong amount is the worst kind here.
    grossAmountFils: Number(row.gross_amount_fils),
    currency: row.currency,
    taxTreatment: row.tax_treatment,
    taxRateBasisPoints: row.tax_rate_basis_points,
    paymentStatus: row.payment_status,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    stripePaymentIntentId: row.stripe_payment_intent_id,
    attributionId: row.attribution_id,
    intakeId: row.intake_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Locked for the duration of the transaction.
 *
 * Two deliveries for the same order can be in flight at once - Stripe retries
 * while the first is still working. Without the lock both read `pending`, both
 * decide to move it to `paid`, and both run the side effects that follow.
 */
async function lockOrder(runner: QueryRunner, orderId: string): Promise<Order | null> {
  const result = await runner.query<OrderRow>(`select * from orders where id = $1 for update`, [
    orderId,
  ]);
  const row = result.rows[0];
  return row ? toOrder(row) : null;
}

export interface SettleInput {
  readonly orderId: string;
  readonly slotHoldId: string | null;
  readonly stripePaymentIntentId?: string | null;
  /** The processor session this event belongs to. Checked against the order. */
  readonly checkoutSessionId?: string | null;
  /** What the processor says was actually paid. Checked against the order. */
  readonly paidAmountFils?: number | null;
  readonly paidCurrency?: string | null;
  readonly now: Date;
}

/**
 * Money arrived. Secure the slot and schedule the booking.
 *
 * The order moves to `paid` FIRST and unconditionally. Whatever happens to the
 * calendar afterwards, the fact that we have the customer money is not in
 * question, and an order left `pending` after a real payment is the state that
 * produces a second charge.
 *
 * Then the slot. If the hold is still live it converts and the booking is
 * scheduled. If it is NOT - a delayed payment that landed after the hold
 * expired, or a slot lost some other way - the order still stays paid and the
 * booking stays `awaiting_schedule`. That is a real, recoverable state: the
 * customer is owed a session, somebody has to reschedule it by hand, and
 * nobody is charged again.
 */
export async function settlePaidOrder(
  runner: QueryRunner,
  input: SettleInput,
): Promise<SettlementOutcome> {
  const order = await lockOrder(runner, input.orderId);
  if (order === null) return "unknown_order";

  /*
    THE EVENT MUST BELONG TO THIS ORDER.
    
    A verified signature proves the event came from the processor. It does NOT
    prove the event is about our order: the order id travels in metadata and
    in client_reference_id, and anything on the same processor account that
    can create a checkout session can set those - a payment link takes
    client_reference_id straight from a URL. Without this check, a one-dirham
    payment naming somebody else's pending order would settle it.
    
    The session id and the amount are both already in hand and were previously
    discarded at exactly the point they were needed.
  */
  const mismatch = describeMismatch(order, input);
  if (mismatch !== null) return "mismatched";

  let moved;
  try {
    moved = transitionPayment(order, "paid", input.now, {
      stripePaymentIntentId: input.stripePaymentIntentId ?? undefined,
    });
  } catch (error) {
    /*
      A success for an order that has been refunded, say. Refusing is right -
      but throwing all the way out would answer the processor with an error it
      would retry indefinitely, and no number of retries makes this legal.
    */
    if (error instanceof InvalidTransitionError) return "refused";
    throw error;
  }

  /*
    Already paid means this delivery has been handled - by an earlier retry,
    or by the other half of a race. Nothing is redone, and in particular no
    second confirmation goes out.
  */
  if (!moved.changed) return "already_settled";

  await runner.query(
    `update orders
        set payment_status = 'paid', stripe_payment_intent_id = coalesce($2, stripe_payment_intent_id),
            updated_at = $3
      where id = $1`,
    [order.id, input.stripePaymentIntentId ?? null, input.now],
  );

  /*
    Paid is the proof. The name, phone and consent typed at the form were kept
    on the intake, because a form matched on email alone cannot prove who sent
    it; now that this attempt has been paid for, they become the customer's.
    In the same transaction, so the receipt queued below and everything sent
    after it greet the person who actually paid.
  */
  await promoteIntakeToCustomer(runner, order.id, input.now);

  /*
    Convert only a hold that is still LIVE and still belongs to this order.
    Adopting an expired one would tell the customer their time is secured when
    the calendar has already let it go.
  */
  const converted =
    input.slotHoldId === null
      ? {
          rows: [] as {
            id: string;
            slot_start: Date;
            slot_end: Date;
            calendar_event_id: string | null;
          }[],
        }
      : await runner.query<{
          id: string;
          slot_start: Date;
          slot_end: Date;
          calendar_event_id: string | null;
        }>(
          `update slot_holds
              set status = 'converted'
            where id = $1 and order_id = $2 and status = 'held' and expires_at > $3
            returning id, slot_start, slot_end, calendar_event_id`,
          [input.slotHoldId, order.id, input.now],
        );

  const claimed = converted.rows[0];
  if (!claimed) return "paid_without_slot";

  /*
    The times come from the hold that was ACTUALLY converted, not from
    anything written earlier. That is the point: one fact, one place. The
    booking was created with no times precisely so the two could never drift.

    The move goes through `scheduleBooking`, which is where the rule that a
    slot must start before it ends lives, and which reads the permitted moves
    off the transition table. A bare UPDATE here would be shorter and would
    quietly route around the one place that says which state changes are legal
    - which is exactly how the Booking aggregate ended up unreferenced by any
    production code while keeping twenty-seven passing tests.
  */
  const booking = await loadBookingForOrder(runner, order.id);
  if (booking === null) {
    /*
      An order with no booking should be impossible - they are written in one
      transaction. Reporting it as settled would claim a session exists for a
      payment we just took, so this refuses to say so.
    */
    return "paid_without_slot";
  }

  // The tentative event travels from the hold to the booking here, so the
  // confirmation step that follows knows which event to promote.
  const scheduled = scheduleBooking(
    booking,
    {
      start: claimed.slot_start,
      end: claimed.slot_end,
      calendarEventId: claimed.calendar_event_id,
    },
    input.now,
  );

  await runner.query(
    `update bookings
        set status = $2, scheduled_start = $3, scheduled_end = $4, updated_at = $5,
            calendar_event_id = $6
      where id = $1`,
    [
      // Scoped to the BOOKING, not the order. A pathway order has two bookings
      // at two different times, and converting one hold must never mark both
      // scheduled.
      scheduled.entity.id,
      scheduled.entity.status,
      scheduled.entity.scheduledStart,
      scheduled.entity.scheduledEnd,
      scheduled.entity.updatedAt,
      scheduled.entity.calendarEventId,
    ],
  );

  return "settled";
}

/**
 * The payment failed, or the checkout session expired.
 *
 * The slot goes back immediately rather than waiting for the sweep, because a
 * time nobody is going to pay for should be sellable again now.
 *
 * The booking is deliberately NOT cancelled. A failed order may still be paid
 * later - the transition table permits `failed -> paid` precisely because a
 * declined attempt can be followed by a successful one - and a cancelled
 * booking could not then be scheduled.
 */
export async function releaseFailedOrder(
  runner: QueryRunner,
  input: SettleInput,
): Promise<SettlementOutcome> {
  const order = await lockOrder(runner, input.orderId);
  if (order === null) return "unknown_order";

  /*
    The FAILURE path is checked too, and it was not before.

    The paid path was guarded and this one was left open, which made the
    cheaper attack the unguarded one: an event naming somebody else's order
    moves it to `failed` and releases its slot hold, and an expiring checkout
    session costs whoever created it nothing at all. Guarding only the path
    where money moves misses that the damage here needs no money.
  */
  const mismatch = describeMismatch(order, input);
  if (mismatch !== null) return "mismatched";

  let moved;
  try {
    moved = transitionPayment(order, "failed", input.now);
  } catch (error) {
    // A failure event for an order already paid. Anomalous and worth an alert,
    // but not a thing a retry can resolve.
    if (error instanceof InvalidTransitionError) return "refused";
    throw error;
  }
  if (!moved.changed) return "released";

  await runner.query(`update orders set payment_status = 'failed', updated_at = $2 where id = $1`, [
    order.id,
    input.now,
  ]);

  if (input.slotHoldId !== null) {
    await runner.query(
      `update slot_holds set status = 'released'
        where id = $1 and order_id = $2 and status = 'held'`,
      [input.slotHoldId, order.id],
    );
  }

  return "released";
}

/**
 * Whether a payment event actually corresponds to the order it names.
 *
 * Returns a reason rather than a boolean so the caller can log WHICH check
 * failed - "mismatched" alone would send somebody reading a database by hand.
 *
 * Each comparison is skipped when the event did not carry that field, rather
 * than failed. An absent value is not evidence of a mismatch, and refusing on
 * it would reject legitimate settlements the day the processor changes what a
 * given event type includes.
 */
export function describeMismatch(order: Order, input: SettleInput): string | null {
  const { checkoutSessionId, paidAmountFils, paidCurrency } = input;

  /*
    A matching session id is REQUIRED, never merely compared when offered.
    Skipping on an absent event field let a caller choose a shape that carries
    no session id and slip every check at once - the attacker picks the event,
    so an optional check is an optional check for them too.

    And it is required even while OUR side is still null. The session id is
    attached in a second transaction after the Stripe round trip, and this
    check used to stand down inside that window on the theory that a
    legitimate event might arrive first. It cannot: the customer only receives
    the checkout URL after the id is attached, so no event about this order
    exists yet. An event landing in the window is therefore somebody else's,
    and a null on our side never equals a real session id.
  */
  if ((checkoutSessionId ?? null) !== order.stripeCheckoutSessionId) {
    return "the event names a different checkout session";
  }

  if (paidAmountFils != null && paidAmountFils !== order.grossAmountFils) {
    return "the amount paid does not match the order";
  }

  if (paidCurrency != null && paidCurrency.toUpperCase() !== order.currency.toUpperCase()) {
    return "the currency paid does not match the order";
  }

  return null;
}

interface BookingRow {
  readonly id: string;
  readonly order_id: string;
  readonly session_slug: string;
  readonly sequence: number;
  readonly status: BookingStatus;
  readonly scheduled_start: Date | null;
  readonly scheduled_end: Date | null;
  readonly customer_timezone: string;
  readonly scheduler_external_id: string | null;
  readonly calendar_event_id: string | null;
  readonly meeting_url: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

/**
 * The booking this order is for.
 *
 * Ordered by sequence and taking the first, because v1 sells single sessions
 * and a pathway would have two. When pathways ship this has to take the
 * booking matching the converted hold rather than simply the first - which is
 * why it returns one booking rather than quietly updating every row for the
 * order, as the SQL it replaced did.
 */
async function loadBookingForOrder(runner: QueryRunner, orderId: string): Promise<Booking | null> {
  const result = await runner.query<BookingRow>(
    `select id, order_id, session_slug, sequence, status,
            scheduled_start, scheduled_end, customer_timezone,
            scheduler_external_id, calendar_event_id, meeting_url,
            created_at, updated_at
       from bookings
      where order_id = $1 and status = 'awaiting_schedule'
      order by sequence
      limit 1`,
    [orderId],
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    id: row.id,
    orderId: row.order_id,
    sessionSlug: row.session_slug,
    sequence: row.sequence,
    status: row.status,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    customerTimezone: row.customer_timezone,
    schedulerExternalId: row.scheduler_external_id,
    calendarEventId: row.calendar_event_id,
    meetingUrl: row.meeting_url,
    meetingProvider: "microsoft_teams",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
