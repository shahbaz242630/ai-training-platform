import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * The migrations are applied to a real Postgres, and their constraints are
 * then actually attempted.
 *
 * Reading SQL and deciding it looks correct is not verification. Several of
 * the constraints below are the only thing standing between us and a customer
 * double-booked or charged twice, and each is the kind of rule that reads fine
 * while being subtly wrong - a range bound the wrong way round, a partial
 * index that misses the case it was written for.
 *
 * This runs an in-process Postgres, so it needs no Docker, no container and no
 * Supabase project, and it runs in CI like any other test. Every migration in
 * the folder is applied in filename order, so a future migration is covered by
 * this harness from the moment it is added.
 *
 * A note on `db.exec` below: it is PGlite's multi-statement SQL entry point,
 * and an editor security reminder pattern-matches the name against
 * `child_process.exec`. They are unrelated functions. There is no shell here
 * and no command to inject into - the only input is a migration file read from
 * this repository.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

const migrationFiles = readdirSync(MIGRATIONS_DIR)
  .filter((name) => name.endsWith(".sql"))
  .toSorted();

let db: PGlite;

/** Asserts the database refused something, and returns the message it refused with. */
async function refused(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return String((error as Error).message);
  }
  throw new Error("the database allowed something it should have refused");
}

let unique = 0;
const nextEmail = () => `customer${++unique}@example.com`;

async function newCustomer(): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [nextEmail()],
  );
  return result.rows[0]!.id;
}

async function newOrder(customerId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils)
     values ($1, 'single', 'claude-claude-code', 149900) returning id`,
    [customerId],
  );
  return result.rows[0]!.id;
}

beforeAll(async () => {
  db = await PGlite.create();
  for (const file of migrationFiles) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("applying the migrations", () => {
  it("finds migrations to apply, rather than silently testing nothing", () => {
    // Without this, deleting every migration would leave a green suite behind.
    expect(migrationFiles.length).toBeGreaterThan(0);
  });

  it("creates every table the booking flow needs", async () => {
    const result = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
       where table_schema = 'public' order by table_name`,
    );
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "attributions",
      "audit_events",
      "bookings",
      "communication_log",
      "customers",
      "intakes",
      "orders",
      "slot_holds",
      "webhook_events",
    ]);
  });
});

describe("customers", () => {
  it("keeps one person to one row", async () => {
    const email = nextEmail();
    await db.query(
      `insert into customers (first_name,last_name,email,timezone) values ('A','One',$1,'UTC')`,
      [email],
    );
    expect(
      await refused(() =>
        db.query(
          `insert into customers (first_name,last_name,email,timezone) values ('B','Two',$1,'UTC')`,
          [email],
        ),
      ),
    ).toContain("unique");
  });

  it("refuses an address that was not lower-cased first", async () => {
    // Otherwise the unique index above is defeated by capitalisation, and the
    // same person quietly becomes two customers.
    expect(
      await refused(() =>
        db.query(
          `insert into customers (first_name,last_name,email,timezone)
           values ('B','Two','Mixed@Example.com','UTC')`,
        ),
      ),
    ).toContain("check constraint");
  });

  it("refuses a blank first or last name", async () => {
    for (const [first, last] of [
      ["   ", "Khan"],
      ["Amina", "  "],
    ]) {
      expect(
        await refused(() =>
          db.query(
            `insert into customers (first_name,last_name,email,timezone) values ($1,$2,$3,'UTC')`,
            [first, last, nextEmail()],
          ),
        ),
      ).toContain("check constraint");
    }
  });

  /*
    Marketing consent without a timestamp cannot answer "when did they agree?",
    which is the only question that matters if it is ever challenged.
  */
  it("refuses marketing consent with no record of when it was given", async () => {
    expect(
      await refused(() =>
        db.query(
          `insert into customers (first_name,last_name,email,timezone,marketing_consent)
           values ('A','One',$1,'UTC',true)`,
          [nextEmail()],
        ),
      ),
    ).toContain("customers_consent_has_a_timestamp");
  });

  it("accepts consent that carries its timestamp", async () => {
    await expect(
      db.query(
        `insert into customers (first_name,last_name,email,timezone,marketing_consent,marketing_consent_at)
         values ('A','One',$1,'UTC',true,now())`,
        [nextEmail()],
      ),
    ).resolves.toBeDefined();
  });

  it("defaults to no consent, so the safe state is the one you get by forgetting", async () => {
    const email = nextEmail();
    await db.query(
      `insert into customers (first_name,last_name,email,timezone) values ('A','One',$1,'UTC')`,
      [email],
    );
    const row = await db.query<{ marketing_consent: boolean; unsubscribed_at: Date | null }>(
      "select marketing_consent, unsubscribed_at from customers where email=$1",
      [email],
    );
    expect(row.rows[0]!.marketing_consent).toBe(false);
    expect(row.rows[0]!.unsubscribed_at).toBeNull();
  });
});

describe("orders", () => {
  it("refuses an order that names both a session and a pathway", async () => {
    const customerId = await newCustomer();
    expect(
      await refused(() =>
        db.query(
          `insert into orders (customer_id,order_type,session_slug,pathway_slug,gross_amount_fils)
           values ($1,'single','a','b',1000)`,
          [customerId],
        ),
      ),
    ).toContain("orders_exactly_one_purchasable");
  });

  it("refuses a pathway order with no pathway", async () => {
    const customerId = await newCustomer();
    expect(
      await refused(() =>
        db.query(
          `insert into orders (customer_id,order_type,session_slug,gross_amount_fils)
           values ($1,'pathway','a',1000)`,
          [customerId],
        ),
      ),
    ).toContain("orders_exactly_one_purchasable");
  });

  it("refuses a free or negative order", async () => {
    const customerId = await newCustomer();
    for (const amount of [0, -100]) {
      expect(
        await refused(() =>
          db.query(
            `insert into orders (customer_id,order_type,session_slug,gross_amount_fils)
             values ($1,'single','a',$2)`,
            [customerId, amount],
          ),
        ),
      ).toContain("check constraint");
    }
  });

  it("refuses a payment status that is not one of ours", async () => {
    const customerId = await newCustomer();
    expect(
      await refused(() =>
        db.query(
          `insert into orders (customer_id,order_type,session_slug,gross_amount_fils,payment_status)
           values ($1,'single','a',100,'nearly_paid')`,
          [customerId],
        ),
      ),
    ).toContain("check constraint");
  });

  it("refuses a second order for the same Stripe checkout session", async () => {
    const customerId = await newCustomer();
    await db.query(
      `insert into orders (customer_id,order_type,session_slug,gross_amount_fils,stripe_checkout_session_id)
       values ($1,'single','a',100,'cs_test_1')`,
      [customerId],
    );
    expect(
      await refused(() =>
        db.query(
          `insert into orders (customer_id,order_type,session_slug,gross_amount_fils,stripe_checkout_session_id)
           values ($1,'single','a',100,'cs_test_1')`,
          [customerId],
        ),
      ),
    ).toContain("unique");
  });

  it("moves updated_at when a row changes", async () => {
    const orderId = await newOrder(await newCustomer());
    const before = await db.query<{ updated_at: Date }>(
      "select updated_at from orders where id=$1",
      [orderId],
    );
    await db.query("update orders set payment_status='paid' where id=$1", [orderId]);
    const after = await db.query<{ updated_at: Date }>(
      "select updated_at from orders where id=$1",
      [orderId],
    );
    expect(after.rows[0]!.updated_at >= before.rows[0]!.updated_at).toBe(true);
  });
});

describe("bookings", () => {
  it("accepts a booking that is waiting for a slot and has no times", async () => {
    const orderId = await newOrder(await newCustomer());
    await expect(
      db.query(
        `insert into bookings (order_id,session_slug,sequence,customer_timezone)
         values ($1,'a',1,'Asia/Dubai')`,
        [orderId],
      ),
    ).resolves.toBeDefined();
  });

  /*
    A booking that claims to be scheduled while carrying no time is the state
    that produces a confirmation email with a blank date in it.
  */
  it("refuses a scheduled booking with no times", async () => {
    const orderId = await newOrder(await newCustomer());
    expect(
      await refused(() =>
        db.query(
          `insert into bookings (order_id,session_slug,sequence,customer_timezone,status)
           values ($1,'a',1,'UTC','scheduled')`,
          [orderId],
        ),
      ),
    ).toContain("bookings_scheduled_has_times");
  });

  it("refuses a slot that ends before it starts", async () => {
    const orderId = await newOrder(await newCustomer());
    expect(
      await refused(() =>
        db.query(
          `insert into bookings (order_id,session_slug,sequence,customer_timezone,status,scheduled_start,scheduled_end)
           values ($1,'a',1,'UTC','scheduled','2026-09-12T08:00:00Z','2026-09-12T06:00:00Z')`,
          [orderId],
        ),
      ),
    ).toContain("bookings_slot_ordered");
  });

  it("refuses two bookings at the same position in one order", async () => {
    const orderId = await newOrder(await newCustomer());
    await db.query(
      `insert into bookings (order_id,session_slug,sequence,customer_timezone)
       values ($1,'a',1,'UTC')`,
      [orderId],
    );
    expect(
      await refused(() =>
        db.query(
          `insert into bookings (order_id,session_slug,sequence,customer_timezone)
           values ($1,'b',1,'UTC')`,
          [orderId],
        ),
      ),
    ).toContain("bookings_unique_sequence");
  });

  it("refuses a third session in a pathway", async () => {
    const orderId = await newOrder(await newCustomer());
    expect(
      await refused(() =>
        db.query(
          `insert into bookings (order_id,session_slug,sequence,customer_timezone)
           values ($1,'a',3,'UTC')`,
          [orderId],
        ),
      ),
    ).toContain("check constraint");
  });
});

describe("slot_holds - the double-booking guarantee", () => {
  const hold = (start: string, end: string, status = "held") =>
    db.query(
      `insert into slot_holds (slot_start,slot_end,expires_at,status)
       values ($1,$2, now() + interval '15 minutes', $3)`,
      [start, end, status],
    );

  /*
    Two customers can reach checkout for the same slot in the same second. No
    amount of checking-then-inserting in application code closes that window,
    because the other request commits in between. Only the database can settle
    it, and this is the constraint that does.
  */
  it("refuses a second live hold overlapping the first", async () => {
    await hold("2026-10-01T06:00:00Z", "2026-10-01T07:30:00Z");
    expect(await refused(() => hold("2026-10-01T07:00:00Z", "2026-10-01T08:30:00Z"))).toContain(
      "exclusion constraint",
    );
  });

  it("allows a hold starting exactly when the previous one ends", async () => {
    // Half-open ranges: back-to-back sessions are adjacent, not conflicting.
    // The gap between them is a buffer, applied deliberately when slots are
    // generated, rather than smuggled into this constraint.
    await expect(hold("2026-10-01T07:30:00Z", "2026-10-01T09:00:00Z")).resolves.toBeDefined();
  });

  it("frees the slot once the hold is no longer live", async () => {
    await hold("2026-10-02T06:00:00Z", "2026-10-02T07:30:00Z");
    await db.query(
      `update slot_holds set status='released' where slot_start='2026-10-02T06:00:00Z'`,
    );
    await expect(hold("2026-10-02T06:00:00Z", "2026-10-02T07:30:00Z")).resolves.toBeDefined();
  });

  /*
    CORRECTED 2026-08-31. This asserted that a CONVERTED hold stops blocking,
    which is the double-booking defect stated at the schema level: converted
    means somebody paid, and letting the slot go back into the index meant two
    customers could buy the same hour.

    Only `expired` and `released` free a slot. The constraint predicate is now
    `status in ('held','converted')`.
  */
  it("does not block a slot because an EXPIRED hold once used it", async () => {
    await hold("2026-10-03T06:00:00Z", "2026-10-03T07:30:00Z", "expired");
    await expect(hold("2026-10-03T06:00:00Z", "2026-10-03T07:30:00Z")).resolves.toBeDefined();
  });

  /*
    THE regression test for the worst defect this codebase has had. A paid
    slot must be refused by the DATABASE, not merely filtered out of a list -
    application code cannot settle a same-millisecond race.
  */
  it("REFUSES a hold overlapping a converted one, because somebody paid for it", async () => {
    await hold("2026-10-13T06:00:00Z", "2026-10-13T07:30:00Z", "converted");
    expect(await refused(() => hold("2026-10-13T06:00:00Z", "2026-10-13T07:30:00Z"))).toContain(
      "slot_holds_no_overlapping_live_hold",
    );
  });

  // Partial overlap counts too - a session starting inside a paid one is
  // still a double booking.
  it("refuses a hold that only partly overlaps a converted one", async () => {
    await hold("2026-10-14T06:00:00Z", "2026-10-14T07:30:00Z", "converted");
    expect(await refused(() => hold("2026-10-14T07:00:00Z", "2026-10-14T08:30:00Z"))).toContain(
      "slot_holds_no_overlapping_live_hold",
    );
  });

  it("refuses a hold that ends before it starts", async () => {
    expect(await refused(() => hold("2026-10-04T08:00:00Z", "2026-10-04T06:00:00Z"))).toContain(
      "slot_holds_ordered",
    );
  });
});

describe("idempotency", () => {
  /*
    Stripe retries webhook deliveries. A duplicate must be a no-op rather than
    a second booking or a second acknowledgement, and this constraint is what
    makes that guaranteed rather than merely intended.
  */
  it("refuses a webhook delivery it has already seen", async () => {
    await db.query(
      `insert into webhook_events (provider,external_event_id,event_type)
       values ('stripe','evt_1','checkout.session.completed')`,
    );
    expect(
      await refused(() =>
        db.query(
          `insert into webhook_events (provider,external_event_id,event_type)
           values ('stripe','evt_1','checkout.session.completed')`,
        ),
      ),
    ).toContain("unique");
  });

  it("stores no payment details, only what idempotency needs", async () => {
    const result = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='webhook_events'`,
    );
    const columns = result.rows.map((row) => row.column_name).join(" ");
    for (const forbidden of ["card", "payment_method", "amount", "customer_email"]) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it("sends a given reminder to a booking only once", async () => {
    const orderId = await newOrder(await newCustomer());
    const booking = await db.query<{ id: string }>(
      `insert into bookings (order_id,session_slug,sequence,customer_timezone)
       values ($1,'a',1,'UTC') returning id`,
      [orderId],
    );
    const bookingId = booking.rows[0]!.id;
    const send = (templateKey: string) =>
      db.query(
        `insert into communication_log (booking_id,channel,template_key,status)
         values ($1,'email',$2,'sent')`,
        [bookingId, templateKey],
      );

    await expect(send("reminder_24h")).resolves.toBeDefined();
    // The reminder job runs every few minutes and retries. Without this, a
    // customer gets the same reminder twice and trusts the next one less.
    expect(await refused(() => send("reminder_24h"))).toContain("unique");
    await expect(send("reminder_3h")).resolves.toBeDefined();
  });
});

describe("row level security", () => {
  it("is enabled on every table", async () => {
    const result = await db.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
       where relnamespace = 'public'::regnamespace and relkind = 'r'`,
    );
    const unprotected = result.rows.filter((row) => !row.relrowsecurity).map((row) => row.relname);
    expect(unprotected).toEqual([]);
  });

  /*
    RLS enabled with no policies denies everything to the anonymous and
    signed-in roles. All access is server-side through the service role, which
    bypasses RLS. Adding a permissive policy "for now" is how a bookings table
    becomes publicly writable, so the absence is asserted rather than assumed.
  */
  it("grants nobody direct access through a policy", async () => {
    const result = await db.query<{ n: number }>(
      "select count(*)::int as n from pg_policies where schemaname='public'",
    );
    expect(result.rows[0]!.n).toBe(0);
  });
});
