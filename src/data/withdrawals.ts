import type { QueryRunner } from "./db";
import { cancelQueuedCommunications, queueForBooking } from "./communications";
import type { BookingStatus } from "@/domain/booking/booking";
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
  /** Set when a notice has already been received for this booking. */
  readonly withdrawal: ExistingWithdrawal | null;
}

export async function findBookingForWithdrawal(
  runner: QueryRunner,
  reference: string,
  email: string,
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
  }>(
    `select b.id, b.status, o.payment_status, b.session_slug, b.scheduled_start,
            b.customer_timezone, greatest(o.created_at, b.created_at) as booked_at,
            o.gross_amount_fils, w.received_at, w.refund_due_fils
       from bookings b
       join orders o on o.id = b.order_id
       join customers c on c.id = o.customer_id
       left join withdrawal_requests w on w.booking_id = b.id
      where upper(left(b.id::text, 8)) = $1
        and c.email = lower($2)
      limit 2`,
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
    withdrawal:
      row.received_at === null
        ? null
        : { receivedAt: row.received_at, refundDueFils: Number(row.refund_due_fils) },
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
}

export interface WithdrawalRecorded extends ExistingWithdrawal {
  /** False when this booking already had a notice: the earlier one stands. */
  readonly created: boolean;
}

/**
 * Keep the notice, once. On the first notice for a booking, in the same
 * transaction: the booking is cancelled (the session will not happen, so no
 * confirmation step may pick it up again), everything still queued for it is
 * withdrawn, and the acknowledgement is queued to go now.
 *
 * Run it inside a transaction: the four writes stand or fall together.
 */
export async function recordWithdrawal(
  runner: QueryRunner,
  input: WithdrawalInput,
): Promise<WithdrawalRecorded> {
  const inserted = await runner.query<{ received_at: Date; refund_due_fils: string | number }>(
    `insert into withdrawal_requests
       (booking_id, full_name, email, statement, refund_due_fils, received_at,
        ip_address, user_agent)
     values ($1, $2, lower($3), $4, $5, $6, $7, $8)
     on conflict (booking_id) do nothing
     returning received_at, refund_due_fils`,
    [
      input.bookingId,
      input.fullName.trim(),
      input.email.trim(),
      input.statement,
      input.refundDueFils,
      input.receivedAt,
      input.ipAddress,
      input.userAgent === null ? null : input.userAgent.slice(0, 500),
    ],
  );

  const created = inserted.rows[0];
  if (!created) {
    const existing = await loadWithdrawal(runner, input.bookingId);
    if (!existing) throw new Error(`withdrawal for booking ${input.bookingId} vanished`);
    return {
      created: false,
      receivedAt: existing.receivedAt,
      refundDueFils: existing.refundDueFils,
    };
  }

  // The statuses a booking may be cancelled from, as the booking domain allows.
  await runner.query(
    `update bookings set status = 'cancelled', updated_at = $2
      where id = $1 and status in ('awaiting_schedule', 'scheduled', 'confirmed')`,
    [input.bookingId, input.receivedAt],
  );
  await cancelQueuedCommunications(runner, input.bookingId);
  await queueForBooking(runner, input.bookingId, [
    { templateKey: "withdrawal_acknowledgement", scheduledFor: input.receivedAt },
  ]);

  return {
    created: true,
    receivedAt: created.received_at,
    refundDueFils: Number(created.refund_due_fils),
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
  }>(
    `select full_name, statement, refund_due_fils, received_at
       from withdrawal_requests where booking_id = $1`,
    [bookingId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    fullName: row.full_name,
    statement: row.statement,
    refundDueFils: Number(row.refund_due_fils),
    receivedAt: row.received_at,
  };
}
