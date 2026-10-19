import { queueForBooking } from "./communications";
import type { QueryRunner } from "./db";
import { releaseConvertedHoldForLostSlot } from "./slot-holds";

/**
 * Cancelling a booking whose session will not happen: the one shape shared by
 * a withdrawal refunded automatically and a full refund made in the payment
 * dashboard (a person approving a withdrawal, or any other full refund).
 *
 * In one transaction with whatever caused it: the booking is cancelled, the
 * time it held goes back on sale, and everything still queued for it is
 * withdrawn except the messages about the withdrawal itself, which are owed
 * to the customer after the cancellation too.
 */

export interface CancelledBooking {
  readonly orderId: string;
}

/** The statuses a booking may be cancelled from, as the booking domain allows. */
const OPEN = "('awaiting_schedule', 'scheduled', 'confirmed')";

/** Cancel one booking if it is still open. Null when it was not: nothing changed. */
export async function cancelOpenBooking(
  runner: QueryRunner,
  bookingId: string,
  now: Date,
): Promise<CancelledBooking | null> {
  const cancelled = await runner.query<{
    order_id: string;
    scheduled_start: Date | null;
    scheduled_end: Date | null;
  }>(
    `update bookings set status = 'cancelled', updated_at = $2
      where id = $1 and status in ${OPEN}
      returning order_id, scheduled_start, scheduled_end`,
    [bookingId, now],
  );
  const slot = cancelled.rows[0];
  if (!slot) return null;
  /*
    The time goes back on sale. Settlement converted a hold for it, and a
    converted hold blocks its time with no end; left behind, the slot would be
    off sale for good with nothing saying so. Released, it is offered again
    from the next availability read, and the sweep deletes its calendar event
    like any other released hold.
  */
  if (slot.scheduled_start && slot.scheduled_end) {
    await releaseConvertedHoldForLostSlot(runner, {
      orderId: slot.order_id,
      slotStart: slot.scheduled_start,
      slotEnd: slot.scheduled_end,
    });
  }
  await runner.query(
    `update communication_log set status = 'cancelled'
      where booking_id = $1 and status = 'queued'
        and template_key not in ('withdrawal_acknowledgement', 'refund_issued',
                                 'cancellation_confirmation')`,
    [bookingId],
  );
  return { orderId: slot.order_id };
}

/**
 * Cancel every booking on an order whose session is still to come. Returns
 * the ids cancelled. A session already started is left alone: nothing moves
 * a delivered session out of its open status, so "open" alone would also
 * catch a session that took place, and a goodwill refund afterwards must not
 * rewrite it as cancelled or delete its calendar event.
 */
export async function cancelOpenBookingsOnOrder(
  runner: QueryRunner,
  orderId: string,
  now: Date,
): Promise<readonly string[]> {
  const open = await runner.query<{ id: string }>(
    `select id from bookings
      where order_id = $1 and status in ${OPEN}
        and (scheduled_start is null or scheduled_start > $2)
      order by sequence`,
    [orderId, now],
  );
  const cancelled: string[] = [];
  for (const { id } of open.rows) {
    if (!(await cancelOpenBooking(runner, id, now))) continue;
    cancelled.push(id);
    /*
      The customer is told, straight from the queue: a refund made by hand in
      the dashboard would otherwise leave them watching their invitation
      disappear with no word from us.
    */
    await queueForBooking(runner, id, [
      { templateKey: "cancellation_confirmation", scheduledFor: now },
    ]);
  }
  return cancelled;
}
