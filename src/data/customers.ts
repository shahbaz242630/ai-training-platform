import type { QueryRunner } from "./db";
import type { PrePaymentIntake } from "@/domain/intake/pre-payment-intake";

/**
 * Storing the person, and what they agreed to.
 *
 * Every value reaches SQL as a bound parameter - never interpolated into the
 * statement text. That is not a style preference: these values come from a
 * public form.
 *
 * THE FORM IS NOT PROOF OF WHO SENT IT. It is matched on email, and nothing
 * checks that the person typing controls that address. So a submission may
 * create a customer, but it may not change one: an existing customer's name,
 * phone and consent are left exactly as they were. What was typed is kept on
 * the intake for that attempt, and promoted to the customer only when the
 * order behind it is paid - the one proof of intent this system has. Before
 * that rule, anybody who knew a customer's email could rewrite the name every
 * reminder greets them by, and switch their marketing consent on.
 */

export interface StoredCustomer {
  readonly id: string;
  readonly isNew: boolean;
}

/**
 * Record somebody who has started a booking, and return their id.
 *
 * Matched on email, which the schema keeps unique and lower-cased, so somebody
 * who books twice is one customer rather than two. A first sighting stores
 * the details as typed - they are the only ones we have. A later sighting
 * changes NOTHING on the row: it returns the id and leaves the person as they
 * were, because the form cannot prove it was them.
 *
 * Marketing consent is never written here, not even for a new person. A
 * ticked box is a request; it becomes consent, with its timestamp, when the
 * attempt is paid for (see promoteIntakeToCustomer). Withdrawal is a separate
 * deliberate act recorded in unsubscribed_at, never an empty checkbox.
 */
export async function upsertCustomer(
  runner: QueryRunner,
  intake: PrePaymentIntake,
  now: Date,
): Promise<StoredCustomer> {
  /*
    `do nothing`, not a no-op `do update`: an update of any kind fires the
    updated_at trigger, and "a later form changes nothing" should mean nothing,
    including the timestamp somebody reads to know when a person last spoke
    to us. The cost is a second query to read the existing id back.
  */
  const inserted = await runner.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, phone, timezone, updated_at)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (email) do nothing
     returning id`,
    [intake.firstName, intake.lastName, intake.email, intake.phone, intake.timezone, now],
  );
  const created = inserted.rows[0];
  if (created) return { id: created.id, isNew: true };

  const existing = await runner.query<{ id: string }>(`select id from customers where email = $1`, [
    intake.email,
  ]);
  const row = existing.rows[0];
  if (!row) throw new Error("upsertCustomer stored nothing, which should be impossible");
  return { id: row.id, isNew: false };
}

export interface StoredIntake {
  readonly id: string;
}

/**
 * Record this attempt: what the person wants, and who they said they are.
 *
 * A row per booking attempt rather than one per customer. Somebody booking a
 * second session has a different goal, and overwriting the first would lose
 * the reason they came the first time. The details and the consent box travel
 * with the attempt for the same reason the customer row is not touched: they
 * are claims, and they are honoured once the attempt is paid for.
 */
export async function recordIntake(
  runner: QueryRunner,
  customerId: string,
  intake: PrePaymentIntake,
): Promise<StoredIntake> {
  const result = await runner.query<{ id: string }>(
    `insert into intakes (customer_id, primary_goal, first_name, last_name, phone, timezone,
                          marketing_consent)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      customerId,
      intake.primaryGoal,
      intake.firstName,
      intake.lastName,
      intake.phone,
      intake.timezone,
      intake.marketingConsent,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("recordIntake stored nothing, which should be impossible");
  return { id: row.id };
}

export interface CapturedLead {
  readonly customerId: string;
  readonly intakeId: string;
  readonly isNewCustomer: boolean;
}

/**
 * The whole pre-payment capture, as one unit.
 *
 * In a transaction so a customer never exists without the intake that explains
 * why - a half-written lead is one nobody can follow up properly.
 */
export async function captureLead(
  runner: QueryRunner,
  intake: PrePaymentIntake,
  now: Date,
): Promise<CapturedLead> {
  const customer = await upsertCustomer(runner, intake, now);
  const stored = await recordIntake(runner, customer.id, intake);
  return { customerId: customer.id, intakeId: stored.id, isNewCustomer: customer.isNew };
}

/**
 * The order is paid: what its intake claimed becomes what we know.
 *
 * Name, phone and timezone are refreshed from the paid intake - people change
 * surname and number, and the most recent thing a PAYING customer told us is
 * the best thing to address them by. A phone left blank keeps the one on file.
 *
 * Consent only ever moves from no to yes here, and never back to no by
 * omission: somebody who opted in last time and left the box unticked today
 * has not withdrawn anything, they simply did not re-state it. Getting this
 * backwards would silently delete consent that was genuinely given.
 *
 * Intakes written before the details lived on them carry no name; those are
 * skipped rather than blanked. Returns whether anything was promoted.
 */
export async function promoteIntakeToCustomer(
  runner: QueryRunner,
  orderId: string,
  now: Date,
): Promise<boolean> {
  const result = await runner.query<{ id: string }>(
    `update customers c
        set first_name = i.first_name,
            last_name  = i.last_name,
            phone      = coalesce(i.phone, c.phone),
            timezone   = coalesce(i.timezone, c.timezone),
            marketing_consent = c.marketing_consent or i.marketing_consent,
            marketing_consent_at = case
              when c.marketing_consent then c.marketing_consent_at
              when i.marketing_consent then $2
              else null
            end,
            updated_at = $2
       from orders o
       join intakes i on i.id = o.intake_id
      where o.id = $1 and c.id = o.customer_id
        and i.first_name is not null and i.last_name is not null
      returning c.id`,
    [orderId, now],
  );
  return result.rows.length > 0;
}

export interface CustomerDetails {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly timezone: string;
}

/** Who a booking is for, by id. Null when there is no such customer. */
export async function findCustomerById(
  runner: QueryRunner,
  customerId: string,
): Promise<CustomerDetails | null> {
  const result = await runner.query<{
    id: string;
    first_name: string;
    last_name: string;
    email: string;
    timezone: string;
  }>(`select id, first_name, last_name, email, timezone from customers where id = $1`, [
    customerId,
  ]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    timezone: row.timezone,
  };
}
