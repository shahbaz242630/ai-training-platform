import type { QueryRunner } from "./db";

/**
 * Deleting what the privacy notice says we stop keeping.
 *
 *   - A booking started but not paid: 30 days.
 *   - Somebody who gave their details but never paid: 30 days.
 *   - Questionnaire answers: 12 months after the last session.
 *   - IP addresses on finished slot holds (security records): 7 days.
 *   - Bookings, payments, invoices and the record of what was agreed: 7 years
 *     after the end of the tax year of the person's last order (the calendar
 *     year, on Dubai's clock), as UAE tax law requires. Then the person goes too.
 *
 * Every step is a plain delete or update keyed on time, so running it again
 * changes nothing, and it is safe to run on every sweep. Run it inside one
 * transaction: a half-finished purge must not leave a booking without its order.
 */

const UNPAID_DAYS = 30;
const LEAD_DAYS = 30;
const INTAKE_DAYS = 365;
const ADDRESS_DAYS = 7;
const RECORD_YEARS = 7;

export interface PurgeReport {
  readonly unpaidOrders: number;
  readonly customers: number;
  readonly intakes: number;
  readonly holdAddresses: number;
  /** Customers whose seven-year record period ended, with everything that was theirs. */
  readonly expiredRecords: number;
}

/** Deletes the bookings (and what hangs off them) and orders the given order-id query selects. */
async function deleteOrders(
  runner: QueryRunner,
  orderIds: string,
  params: readonly unknown[],
): Promise<number> {
  await runner.query(
    `delete from withdrawal_requests
      where booking_id in (select id from bookings where order_id in (${orderIds}))`,
    params,
  );
  // communication_log goes with its booking (on delete cascade).
  await runner.query(`delete from bookings where order_id in (${orderIds})`, params);
  await runner.query(`delete from booking_consents where order_id in (${orderIds})`, params);
  const deleted = await runner.query<{ id: string }>(
    `delete from orders where id in (${orderIds}) returning id`,
    params,
  );
  return deleted.rows.length;
}

export async function purgeExpiredPersonalData(
  runner: QueryRunner,
  now: Date,
): Promise<PurgeReport> {
  /*
    Seven years after the end of the tax year: a person whose latest record is
    in year Y is kept to the end of Y + 7 and goes from 1 January of Y + 8, on
    Dubai's clock. The latest record is the latest of any order being made or
    changed (a refund is a later record) and any of their sessions taking place
    or changing, so nothing dated in a later tax year goes a year early.
  */
  const expiredCustomers = `
    select o.customer_id from orders o
      left join bookings b on b.order_id = o.id
     group by o.customer_id
    having extract(year from max(greatest(o.created_at, o.updated_at,
                                          coalesce(b.scheduled_end, o.created_at),
                                          coalesce(b.updated_at, o.created_at)))
                   at time zone 'Asia/Dubai')
           + ${RECORD_YEARS + 1} <= extract(year from $1::timestamptz at time zone 'Asia/Dubai')`;
  const expiredCustomerIds = (
    await runner.query<{ customer_id: string }>(expiredCustomers, [now])
  ).rows.map((row) => row.customer_id);
  if (expiredCustomerIds.length > 0) {
    await deleteOrders(runner, `select id from orders where customer_id = any($1)`, [
      expiredCustomerIds,
    ]);
    // intakes go with the person (on delete cascade).
    await runner.query(`delete from customers where id = any($1)`, [expiredCustomerIds]);
  }

  const unpaidOrders = await deleteOrders(
    runner,
    `select id from orders
      where payment_status in ('pending', 'failed')
        and created_at < $1::timestamptz - interval '${UNPAID_DAYS} days'`,
    [now],
  );

  /*
    Nobody with an order left (paid, or unpaid but recent) is touched here, nor
    anybody who came back: a returning person's row keeps its old dates, so a
    fresh questionnaire, or a time they are holding right now, is what shows
    they are in the middle of booking.
  */
  const customers = await runner.query<{ id: string }>(
    `delete from customers c
      where greatest(c.created_at, c.updated_at) < $1::timestamptz - interval '${LEAD_DAYS} days'
        and not exists (select 1 from orders o where o.customer_id = c.id)
        and not exists (select 1 from intakes i where i.customer_id = c.id
                           and i.created_at >= $1::timestamptz - interval '${LEAD_DAYS} days')
        and not exists (select 1 from slot_holds h
                         where h.customer_id = c.id and h.status = 'held')
      returning c.id`,
    [now],
  );

  /*
    The questionnaire is kept while any paid booking is still to come, and for
    12 months after the last one ended. A booking that never had a time counts
    from when it last changed (a cancellation, say). A questionnaire under 12
    months old is never deleted: it is written before its order exists, so a
    past customer starting a new booking has one with nothing attached yet.
  */
  const intakes = await runner.query<{ id: string }>(
    `delete from intakes i
      where i.created_at < $1::timestamptz - interval '${INTAKE_DAYS} days'
        and exists (select 1 from orders o where o.customer_id = i.customer_id
                       and o.payment_status in ('paid', 'refunded', 'partially_refunded'))
        and not exists (
          select 1 from bookings b join orders o on o.id = b.order_id
           where o.customer_id = i.customer_id
             and o.payment_status in ('paid', 'partially_refunded')
             and b.status in ('awaiting_schedule', 'scheduled', 'confirmed'))
        and (select max(coalesce(b.scheduled_end, b.updated_at))
               from bookings b join orders o on o.id = b.order_id
              where o.customer_id = i.customer_id)
            < $1::timestamptz - interval '${INTAKE_DAYS} days'
      returning i.id`,
    [now],
  );

  // A live hold keeps its address: the per-address limit is counted from it.
  const holdAddresses = await runner.query<{ id: string }>(
    `update slot_holds set client_address = null
      where client_address is not null and status <> 'held'
        and created_at < $1::timestamptz - interval '${ADDRESS_DAYS} days'
      returning id`,
    [now],
  );

  return {
    unpaidOrders,
    customers: customers.rows.length,
    intakes: intakes.rows.length,
    holdAddresses: holdAddresses.rows.length,
    expiredRecords: expiredCustomerIds.length,
  };
}
