import type { QueryRunner } from "./db";

/**
 * Finding a customer's upcoming bookings from the email address they booked
 * with, for "Manage my booking". The answer only ever travels by email to that
 * same address, so nothing found here is shown to whoever typed it.
 */

export interface UpcomingBooking {
  readonly bookingId: string;
  readonly sessionSlug: string;
  readonly scheduledStart: Date;
  readonly customerTimezone: string;
  readonly firstName: string;
}

/** Enough for anyone's real bookings; a cap so one request can never become a long email. */
const MAX_BOOKINGS = 5;

export async function findUpcomingBookingsForEmail(
  runner: QueryRunner,
  input: { readonly email: string; readonly reference: string | null; readonly now: Date },
): Promise<readonly UpcomingBooking[]> {
  const result = await runner.query<{
    id: string;
    session_slug: string;
    scheduled_start: Date;
    customer_timezone: string;
    first_name: string;
  }>(
    `select b.id, b.session_slug, b.scheduled_start, b.customer_timezone, c.first_name
       from bookings b
       join orders o on o.id = b.order_id
       join customers c on c.id = o.customer_id
      where c.email = lower($1)
        and o.payment_status = 'paid'
        and b.status in ('scheduled', 'confirmed')
        and b.scheduled_start > $2
        and ($3::text is null or upper(left(b.id::text, 8)) = $3)
      order by b.scheduled_start
      limit ${MAX_BOOKINGS}`,
    [input.email.trim(), input.now, input.reference],
  );
  return result.rows.map((row) => ({
    bookingId: row.id,
    sessionSlug: row.session_slug,
    scheduledStart: row.scheduled_start,
    customerTimezone: row.customer_timezone,
    firstName: row.first_name,
  }));
}
