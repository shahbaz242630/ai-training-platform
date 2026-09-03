import type { QueryRunner } from "./db";
import type { PrePaymentIntake } from "@/domain/intake/pre-payment-intake";

/**
 * Storing the person, and what they agreed to.
 *
 * Every value reaches SQL as a bound parameter - never interpolated into the
 * statement text. That is not a style preference: these values come from a
 * public form.
 */

export interface StoredCustomer {
  readonly id: string;
  readonly isNew: boolean;
}

/**
 * Record somebody who has started a booking, and return their id.
 *
 * Matched on email, which the schema keeps unique and lower-cased, so somebody
 * who books twice is one customer rather than two. A returning customer's
 * details are refreshed - people change surname and phone number, and the most
 * recent thing they told us is the best thing to address them by.
 *
 * CONSENT IS NOT REFRESHED THE SAME WAY. It only ever moves from no to yes,
 * and never back to no by omission: somebody who opted in last month and left
 * the box unticked today has not withdrawn anything, they simply did not
 * re-state it. Withdrawal is a deliberate act recorded in unsubscribed_at, not
 * an empty checkbox. Getting this backwards would silently delete consent that
 * was genuinely given, or - far worse - resurrect consent somebody withdrew.
 */
export async function upsertCustomer(
  runner: QueryRunner,
  intake: PrePaymentIntake,
  now: Date,
): Promise<StoredCustomer> {
  const consentAt = intake.marketingConsent ? now : null;

  const result = await runner.query<{ id: string; inserted: boolean }>(
    `insert into customers (first_name, last_name, email, phone, timezone,
                            marketing_consent, marketing_consent_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (email) do update set
       first_name = excluded.first_name,
       last_name  = excluded.last_name,
       phone      = coalesce(excluded.phone, customers.phone),
       timezone   = excluded.timezone,
       marketing_consent = customers.marketing_consent or excluded.marketing_consent,
       marketing_consent_at = case
         when customers.marketing_consent then customers.marketing_consent_at
         when excluded.marketing_consent then excluded.marketing_consent_at
         else null
       end
     returning id, (xmax = 0) as inserted`,
    [
      intake.firstName,
      intake.lastName,
      intake.email,
      intake.phone,
      intake.timezone,
      intake.marketingConsent,
      consentAt,
    ],
  );

  const row = result.rows[0];
  if (!row) throw new Error("upsertCustomer stored nothing, which should be impossible");
  return { id: row.id, isNew: row.inserted };
}

export interface StoredIntake {
  readonly id: string;
}

/**
 * Record what this person said they want out of the session.
 *
 * A row per booking attempt rather than one per customer: somebody booking a
 * second session has a different goal, and overwriting the first would lose
 * the reason they came the first time.
 */
export async function recordIntake(
  runner: QueryRunner,
  customerId: string,
  primaryGoal: string,
): Promise<StoredIntake> {
  const result = await runner.query<{ id: string }>(
    `insert into intakes (customer_id, primary_goal) values ($1, $2) returning id`,
    [customerId, primaryGoal],
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
  const stored = await recordIntake(runner, customer.id, intake.primaryGoal);
  return { customerId: customer.id, intakeId: stored.id, isNewCustomer: customer.isNew };
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
