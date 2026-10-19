import type { QueryRunner } from "./db";
import { cancelOpenBooking } from "./booking-cancellation";
import { queueForBooking } from "./communications";
import { createWithdrawalRefund } from "./refunds";
import { BOOKING_POLICY } from "@/config/site";
import type { BookingStatus } from "@/domain/booking/booking";
import type { WithdrawalRoute } from "@/domain/booking/withdrawal";
import type { Fils } from "@/lib/money";

/**
 * Withdrawals: finding the booking a notice is for, keeping the notice, and
 * what keeping it does.
 *
 * A booking is found only by its reference AND the email it was booked with,
 * together. Neither alone is enough, so the form cannot be used to learn who
 * booked what from an email address, or whose a reference is.
 */

export interface ExistingWithdrawal {
  readonly receivedAt: Date;
  readonly refundDueFils: Fils;
  /** Who decides the refund, chosen when the notice arrived and never changed. */
  readonly route: WithdrawalRoute;
  /** The desk declined it: the booking stands and nothing is refunded. */
  readonly declined: boolean;
}

export interface BookingForWithdrawal {
  readonly bookingId: string;
  readonly bookingStatus: BookingStatus;
  readonly paymentStatus: string;
  readonly sessionSlug: string;
  readonly scheduledStart: Date | null;
  readonly customerTimezone: string;
  /** The later of the order and the booking being created: when the contract was made. */
  readonly bookedAt: Date;
  readonly amountPaidFils: Fils;
  readonly bookingsOnOrder: number;
  /** The payment behind the order: what the card country is asked about. */
  readonly paymentIntentId: string | null;
  /** Set when a notice has already been received for this booking. */
  readonly withdrawal: ExistingWithdrawal | null;
}

export async function findBookingForWithdrawal(
  runner: QueryRunner,
  reference: string,
  email: string,
  /*
    The confirm step locks the order: a refund event moving it on between the
    decision and the notice being kept would otherwise go unseen. The look-up
    step writes nothing and takes no lock.
  */
  options: { readonly lock?: boolean } = {},
): Promise<BookingForWithdrawal | null> {
  const result = await runner.query<{
    id: string;
    status: BookingStatus;
    payment_status: string;
    session_slug: string;
    scheduled_start: Date | null;
    customer_timezone: string;
    booked_at: Date;
    gross_amount_fils: string | number;
    received_at: Date | null;
    refund_due_fils: string | number | null;
    route: WithdrawalRoute | null;
    declined: boolean;
    stripe_payment_intent_id: string | null;
    bookings_on_order: number;
  }>(
    `select b.id, b.status, o.payment_status, b.session_slug, b.scheduled_start,
            b.customer_timezone, greatest(o.created_at, b.created_at) as booked_at,
            o.gross_amount_fils, o.stripe_payment_intent_id, w.received_at,
            w.refund_due_fils, w.route, (d.id is not null) as declined,
            (select count(*)::int from bookings x where x.order_id = o.id) as bookings_on_order
       from bookings b
       join orders o on o.id = b.order_id
       join customers c on c.id = o.customer_id
       left join withdrawal_requests w on w.booking_id = b.id
       left join withdrawal_decisions d on d.booking_id = b.id
      where upper(left(b.id::text, 8)) = $1
        and c.email = lower($2)
      limit 2${options.lock ? " for update of o" : ""}`,
    [reference, email.trim()],
  );
  // Two bookings for one person sharing a reference is vanishingly unlikely;
  // if it ever happens, neither is guessed at and the customer is asked to email.
  if (result.rows.length !== 1) return null;
  const row = result.rows[0]!;
  return {
    bookingId: row.id,
    bookingStatus: row.status,
    paymentStatus: row.payment_status,
    sessionSlug: row.session_slug,
    scheduledStart: row.scheduled_start,
    customerTimezone: row.customer_timezone,
    bookedAt: row.booked_at,
    amountPaidFils: Number(row.gross_amount_fils),
    bookingsOnOrder: row.bookings_on_order,
    paymentIntentId: row.stripe_payment_intent_id,
    withdrawal:
      row.received_at === null
        ? null
        : {
            receivedAt: row.received_at,
            refundDueFils: Number(row.refund_due_fils),
            route: row.route ?? "automatic",
            declined: row.declined,
          },
  };
}

export interface WithdrawalInput {
  readonly bookingId: string;
  readonly fullName: string;
  readonly email: string;
  readonly statement: string;
  readonly refundDueFils: Fils;
  readonly receivedAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly route: WithdrawalRoute;
  /** The card country the route was chosen on; null when it could not be read. */
  readonly cardCountry: string | null;
}

export interface WithdrawalRecorded extends ExistingWithdrawal {
  /** False when this booking already had a notice: the earlier one stands. */
  readonly created: boolean;
}

/**
 * Keep the notice, once, with the route chosen for it.
 *
 * Automatic (a UK or EU card), in the same transaction: the booking is
 * cancelled (the session will not happen, so no confirmation step may pick it
 * up again), its time goes back on sale, everything still queued for it is
 * withdrawn, the full refund is written for the sweep, and the acknowledgement
 * is queued to go now.
 *
 * Desk (any other card): only the notice and the acknowledgement. The booking,
 * its time and its reminders stay exactly as they were, and no money moves,
 * until a person decides. Approving is a full refund in the payment dashboard,
 * which cancels the booking when its event arrives; declining leaves the
 * booking as it is. A customer who sent the notice in error therefore still
 * has their session, and one who is owed the refund gets it within the 14 days.
 *
 * Run it inside a transaction: the writes stand or fall together.
 */
export async function recordWithdrawal(
  runner: QueryRunner,
  input: WithdrawalInput,
): Promise<WithdrawalRecorded> {
  const inserted = await runner.query<{
    id: string;
    received_at: Date;
    refund_due_fils: string | number;
    route: WithdrawalRoute;
  }>(
    `insert into withdrawal_requests
       (booking_id, full_name, email, statement, refund_due_fils, received_at,
        ip_address, user_agent, route, card_country)
     values ($1, $2, lower($3), $4, $5, $6, $7, $8, $9, $10)
     on conflict (booking_id) do nothing
     returning id, received_at, refund_due_fils, route`,
    [
      input.bookingId,
      input.fullName.trim(),
      input.email.trim(),
      input.statement,
      input.refundDueFils,
      input.receivedAt,
      input.ipAddress,
      input.userAgent === null ? null : input.userAgent.slice(0, 500),
      input.route,
      input.cardCountry,
    ],
  );

  const created = inserted.rows[0];
  if (!created) {
    // The earlier notice stands, route included: a second look at the card cannot change it.
    const existing = await loadWithdrawal(runner, input.bookingId);
    if (!existing) throw new Error(`withdrawal for booking ${input.bookingId} vanished`);
    return {
      created: false,
      receivedAt: existing.receivedAt,
      refundDueFils: existing.refundDueFils,
      route: existing.route,
      declined: existing.declined,
    };
  }

  if (created.route === "automatic") {
    const cancelled = await cancelOpenBooking(runner, input.bookingId, input.receivedAt);
    /*
      The refund the law says is owed, in full, written with the notice so one
      cannot exist without the other. Only when this notice closed the booking:
      a booking that had already finished or been cancelled keeps its notice as
      evidence, and a person decides what, if anything, goes back. The sweep
      asks the processor for it; nothing here talks to the network.
    */
    if (cancelled && input.refundDueFils > 0) {
      await createWithdrawalRefund(runner, {
        orderId: cancelled.orderId,
        withdrawalRequestId: created.id,
        amountFils: input.refundDueFils,
        now: input.receivedAt,
      });
    }
  }
  await queueForBooking(runner, input.bookingId, [
    { templateKey: "withdrawal_acknowledgement", scheduledFor: input.receivedAt },
  ]);

  return {
    created: true,
    receivedAt: created.received_at,
    refundDueFils: Number(created.refund_due_fils),
    route: created.route,
    declined: false,
  };
}

export interface WithdrawalForEmail extends ExistingWithdrawal {
  readonly fullName: string;
  readonly statement: string;
}

export async function loadWithdrawal(
  runner: QueryRunner,
  bookingId: string,
): Promise<WithdrawalForEmail | null> {
  const result = await runner.query<{
    full_name: string;
    statement: string;
    refund_due_fils: string | number;
    received_at: Date;
    route: WithdrawalRoute;
    declined: boolean;
  }>(
    `select w.full_name, w.statement, w.refund_due_fils, w.received_at, w.route,
            (d.id is not null) as declined
       from withdrawal_requests w
       left join withdrawal_decisions d on d.booking_id = w.booking_id
      where w.booking_id = $1`,
    [bookingId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    fullName: row.full_name,
    statement: row.statement,
    refundDueFils: Number(row.refund_due_fils),
    receivedAt: row.received_at,
    route: row.route,
    declined: row.declined,
  };
}

/** A withdrawal waiting for the desk: what the alert needs to find the payment and decide. */
export interface WithdrawalForDesk {
  readonly bookingId: string;
  readonly sessionSlug: string;
  readonly scheduledStart: Date | null;
  readonly receivedAt: Date;
  /** Null when the card's country could not be read. */
  readonly cardCountry: string | null;
  readonly amountFils: Fils;
  readonly paymentIntentId: string | null;
}

/**
 * Notices the desk has still to decide. One stops being listed, and its alert
 * closes, when the payment is refunded in full (the approval), the desk
 * declines it, the booking is cancelled, or the refund days are over. The
 * session starting does NOT close it: a notice sent hours before a session is
 * still owed a decision, and closing it quietly would leave the customer told
 * "being reviewed" with nobody reminded to answer.
 */
export async function listWithdrawalsForDesk(
  runner: QueryRunner,
  now: Date,
): Promise<readonly WithdrawalForDesk[]> {
  const result = await runner.query<{
    booking_id: string;
    session_slug: string;
    scheduled_start: Date | null;
    received_at: Date;
    card_country: string | null;
    gross_amount_fils: string | number;
    stripe_payment_intent_id: string | null;
  }>(
    `select b.id as booking_id, b.session_slug, b.scheduled_start, w.received_at, w.card_country,
            o.gross_amount_fils, o.stripe_payment_intent_id
       from withdrawal_requests w
       join bookings b on b.id = w.booking_id
       join orders o on o.id = b.order_id
       left join withdrawal_decisions d on d.booking_id = w.booking_id
      where w.route = 'desk'
        and d.id is null
        -- A part refund is a gesture, not the decision: the alert stays until one is made.
        and o.payment_status in ('paid', 'partially_refunded')
        and b.status in ('awaiting_schedule', 'scheduled', 'confirmed')
        and w.received_at > $1::timestamptz - make_interval(days => $2)
      order by w.received_at`,
    [now, BOOKING_POLICY.deskDecisionDays],
  );
  return result.rows.map((row) => ({
    bookingId: row.booking_id,
    sessionSlug: row.session_slug,
    scheduledStart: row.scheduled_start,
    receivedAt: row.received_at,
    cardCountry: row.card_country,
    amountFils: Number(row.gross_amount_fils),
    paymentIntentId: row.stripe_payment_intent_id,
  }));
}

export type DeclineOutcome = "declined" | "already_declined" | "not_for_the_desk";

/**
 * The desk declines a notice it decides: the booking stands and nothing is
 * refunded. Only a desk notice whose order has not been refunded in full can
 * be declined; asking twice is the same decision.
 */
export async function declineWithdrawal(
  runner: QueryRunner,
  bookingId: string,
  now: Date,
): Promise<DeclineOutcome> {
  const notice = await runner.query<{ route: WithdrawalRoute; payment_status: string }>(
    `select w.route, o.payment_status
       from withdrawal_requests w
       join bookings b on b.id = w.booking_id
       join orders o on o.id = b.order_id
      where w.booking_id = $1
      for update of o`,
    [bookingId],
  );
  const row = notice.rows[0];
  if (!row || row.route !== "desk" || row.payment_status === "refunded") return "not_for_the_desk";
  const inserted = await runner.query(
    `insert into withdrawal_decisions (booking_id, decision, decided_at)
     values ($1, 'declined', $2)
     on conflict (booking_id) do nothing
     returning id`,
    [bookingId, now],
  );
  return inserted.rows.length === 1 ? "declined" : "already_declined";
}

/** A desk notice as the decline page shows it. */
export interface DeskNotice {
  readonly bookingId: string;
  readonly sessionSlug: string;
  readonly receivedAt: Date;
  readonly cardCountry: string | null;
  readonly amountFils: Fils;
  readonly route: WithdrawalRoute;
  readonly paymentStatus: string;
  readonly declined: boolean;
  readonly scheduledStart: Date | null;
}

export async function loadDeskNotice(
  runner: QueryRunner,
  bookingId: string,
): Promise<DeskNotice | null> {
  const result = await runner.query<{
    session_slug: string;
    received_at: Date;
    card_country: string | null;
    gross_amount_fils: string | number;
    route: WithdrawalRoute;
    payment_status: string;
    declined: boolean;
    scheduled_start: Date | null;
  }>(
    `select b.session_slug, w.received_at, w.card_country, o.gross_amount_fils, w.route,
            o.payment_status, (d.id is not null) as declined, b.scheduled_start
       from withdrawal_requests w
       join bookings b on b.id = w.booking_id
       join orders o on o.id = b.order_id
       left join withdrawal_decisions d on d.booking_id = w.booking_id
      where w.booking_id = $1`,
    [bookingId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    bookingId,
    sessionSlug: row.session_slug,
    receivedAt: row.received_at,
    cardCountry: row.card_country,
    amountFils: Number(row.gross_amount_fils),
    route: row.route,
    paymentStatus: row.payment_status,
    declined: row.declined,
    scheduledStart: row.scheduled_start,
  };
}
