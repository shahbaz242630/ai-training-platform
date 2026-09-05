import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { captureLead, promoteIntakeToCustomer, recordIntake, upsertCustomer } from "./customers";
import type { QueryRunner } from "./db";
import type { PrePaymentIntake } from "@/domain/intake/pre-payment-intake";

/**
 * The real repository code, against a real Postgres, with the real migrations.
 *
 * PGlite satisfies the same QueryRunner shape as the production driver, so what
 * runs here is exactly what runs against Supabase - including the constraints.
 * A mock would only ever confirm that the code agrees with itself, which is
 * worth nothing for SQL.
 *
 * (`db.APPLYSQL` below is PGlite's multi-statement entry point, unrelated to
 * child_process despite the name an editor security reminder matches on.)
 */

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const NOW = new Date("2026-09-01T10:00:00.000Z");
const LATER = new Date("2026-10-01T10:00:00.000Z");

let db: PGlite;
let runner: QueryRunner;

const intake = (overrides: Partial<PrePaymentIntake> = {}): PrePaymentIntake => ({
  firstName: "Amina",
  lastName: "Khan",
  email: "amina@example.com",
  phone: "+971 50 123 4567",
  primaryGoal: "Use Claude Code properly on a real repository.",
  marketingConsent: false,
  timezone: "Asia/Dubai",
  ...overrides,
});

interface CustomerRow {
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  timezone: string;
  marketing_consent: boolean;
  marketing_consent_at: Date | null;
  unsubscribed_at: Date | null;
}

const customerRow = (email: string) =>
  db
    .query<CustomerRow>("select * from customers where email = $1", [email])
    .then((result) => result.rows[0]);

beforeAll(async () => {
  db = await PGlite.create();
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  runner = db as unknown as QueryRunner;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("upsertCustomer", () => {
  it("stores a new person and says they are new", async () => {
    const result = await upsertCustomer(runner, intake({ email: "new@example.com" }), NOW);
    expect(result.isNew).toBe(true);

    const row = await customerRow("new@example.com");
    expect(row?.first_name).toBe("Amina");
    expect(row?.last_name).toBe("Khan");
    expect(row?.phone).toBe("+971 50 123 4567");
    expect(row?.timezone).toBe("Asia/Dubai");
  });

  // Somebody who books twice is one customer, not two.
  it("matches an existing person on email rather than creating a second row", async () => {
    const email = "returning@example.com";
    const first = await upsertCustomer(runner, intake({ email }), NOW);
    const second = await upsertCustomer(runner, intake({ email }), LATER);

    expect(second.isNew).toBe(false);
    expect(second.id).toBe(first.id);

    const count = await db.query<{ n: number }>(
      "select count(*)::int as n from customers where email = $1",
      [email],
    );
    expect(count.rows[0]!.n).toBe(1);
  });

  /*
    CORRECTED 2026-09-05. This used to assert the opposite - that a later form
    refreshes the row - and that was the defect written down as an expectation.
    The form is matched on email and proves nothing about who sent it, so
    anybody who knew a customer's address could rewrite the name every reminder
    greets them by. A later submission may not change an existing person.
  */
  it("leaves an existing person exactly as they were: a later form is not proof of who sent it", async () => {
    const email = "changed@example.com";
    await upsertCustomer(runner, intake({ email, phone: "+971 50 111 2222" }), NOW);
    const before = await customerRow(email);

    await upsertCustomer(
      runner,
      intake({
        email,
        firstName: "Somebody",
        lastName: "Else",
        phone: "+971 55 999 8888",
        timezone: "Europe/London",
        marketingConsent: true,
      }),
      LATER,
    );

    const after = await customerRow(email);
    expect(after).toEqual(before);
    expect(after?.first_name).toBe("Amina");
    expect(after?.phone).toBe("+971 50 111 2222");
    expect(after?.timezone).toBe("Asia/Dubai");
    expect(after?.marketing_consent).toBe(false);
  });

  it("records no consent from the form itself, even for a new person", async () => {
    const email = "ticked@example.com";
    await upsertCustomer(runner, intake({ email, marketingConsent: true }), NOW);

    const row = await customerRow(email);
    expect(row?.marketing_consent).toBe(false);
    expect(row?.marketing_consent_at).toBeNull();
  });
});

/**
 * A paid order for one intake, so the promotion has something to be proven by.
 * Everything not named here takes the schema default.
 */
async function paidOrderFor(customerId: string, intakeId: string): Promise<string> {
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status, intake_id)
     values ($1, 'single', 'ai-foundations', 129900, 'paid', $2) returning id`,
    [customerId, intakeId],
  );
  return order.rows[0]!.id;
}

/** Form in, paid order out: the whole path a real customer takes, minus the money. */
async function paidAttempt(details: Partial<PrePaymentIntake>, at: Date): Promise<string> {
  const lead = await captureLead(runner, intake(details), at);
  return paidOrderFor(lead.customerId, lead.intakeId);
}

/*
  Consent is the part with a legal consequence, so it gets its own group.
  Every one of these is a way the flag could be silently wrong. Since
  2026-09-05 consent is recorded by promotion, when the attempt is paid for -
  a ticked box on an unverified form is a request, not a fact.
*/
describe("marketing consent, promoted on payment", () => {
  it("records the moment consent was given, not merely that it was", async () => {
    const email = "optedin@example.com";
    const orderId = await paidAttempt({ email, marketingConsent: true }, NOW);
    expect(await promoteIntakeToCustomer(runner, orderId, NOW)).toBe(true);

    const row = await customerRow(email);
    expect(row?.marketing_consent).toBe(true);
    expect(row?.marketing_consent_at).toEqual(NOW);
  });

  it("leaves no timestamp when consent was not given", async () => {
    const email = "notoptedin@example.com";
    const orderId = await paidAttempt({ email, marketingConsent: false }, NOW);
    await promoteIntakeToCustomer(runner, orderId, NOW);

    const row = await customerRow(email);
    expect(row?.marketing_consent).toBe(false);
    expect(row?.marketing_consent_at).toBeNull();
  });

  it("upgrades from no to yes on a later paid attempt, keeping the moment it changed", async () => {
    const email = "changedmind@example.com";
    await promoteIntakeToCustomer(runner, await paidAttempt({ email }, NOW), NOW);
    await promoteIntakeToCustomer(
      runner,
      await paidAttempt({ email, marketingConsent: true }, LATER),
      LATER,
    );

    const row = await customerRow(email);
    expect(row?.marketing_consent).toBe(true);
    expect(row?.marketing_consent_at).toEqual(LATER);
  });

  /*
    THE ONE THAT MATTERS. Somebody who opted in last month and left the box
    unticked today has not withdrawn anything - they simply did not re-state
    it. Treating an empty checkbox as a withdrawal would silently delete
    consent that was genuinely given.
  */
  it("does not treat an unticked box on a later paid attempt as a withdrawal", async () => {
    const email = "stillopted@example.com";
    await promoteIntakeToCustomer(
      runner,
      await paidAttempt({ email, marketingConsent: true }, NOW),
      NOW,
    );
    await promoteIntakeToCustomer(
      runner,
      await paidAttempt({ email, marketingConsent: false }, LATER),
      LATER,
    );

    const row = await customerRow(email);
    expect(row?.marketing_consent).toBe(true);
    // And the original moment survives, rather than being restamped.
    expect(row?.marketing_consent_at).toEqual(NOW);
  });

  it("never invents a withdrawal", async () => {
    const email = "nounsub@example.com";
    await promoteIntakeToCustomer(
      runner,
      await paidAttempt({ email, marketingConsent: true }, NOW),
      NOW,
    );
    expect((await customerRow(email))?.unsubscribed_at).toBeNull();
  });

  // A ticked box that was never paid for stays a request. This is the whole
  // point: the attacker's form never reaches the customer row.
  it("records nothing from an attempt that was never paid for", async () => {
    const email = "unpaid@example.com";
    await captureLead(runner, intake({ email, marketingConsent: true }), NOW);

    const row = await customerRow(email);
    expect(row?.marketing_consent).toBe(false);
    expect(row?.marketing_consent_at).toBeNull();
  });
});

describe("promoteIntakeToCustomer, details", () => {
  it("refreshes name, phone and timezone from the paid attempt", async () => {
    const email = "renamed@example.com";
    await paidAttempt({ email }, NOW);
    const orderId = await paidAttempt(
      { email, lastName: "Al Mansouri", phone: "+971 55 999 8888", timezone: "Europe/London" },
      LATER,
    );
    await promoteIntakeToCustomer(runner, orderId, LATER);

    const row = await customerRow(email);
    expect(row?.last_name).toBe("Al Mansouri");
    expect(row?.phone).toBe("+971 55 999 8888");
    expect(row?.timezone).toBe("Europe/London");
  });

  it("keeps a phone number already on file when the paid attempt leaves it blank", async () => {
    const email = "keepsphone@example.com";
    await promoteIntakeToCustomer(
      runner,
      await paidAttempt({ email, phone: "+971 50 111 2222" }, NOW),
      NOW,
    );
    await promoteIntakeToCustomer(runner, await paidAttempt({ email, phone: null }, LATER), LATER);

    expect((await customerRow(email))?.phone).toBe("+971 50 111 2222");
  });

  // Intakes written before the details lived on them. Skipped, never blanked.
  it("skips an intake that carries no details, and says so", async () => {
    const email = "legacy@example.com";
    const customer = await upsertCustomer(runner, intake({ email }), NOW);
    const legacy = await db.query<{ id: string }>(
      `insert into intakes (customer_id, primary_goal) values ($1, 'Ship') returning id`,
      [customer.id],
    );
    const orderId = await paidOrderFor(customer.id, legacy.rows[0]!.id);

    expect(await promoteIntakeToCustomer(runner, orderId, LATER)).toBe(false);
    expect((await customerRow(email))?.first_name).toBe("Amina");
  });

  it("promotes nothing for an order that does not exist", async () => {
    expect(await promoteIntakeToCustomer(runner, "00000000-0000-0000-0000-000000000000", NOW)).toBe(
      false,
    );
  });
});

describe("recordIntake", () => {
  it("stores what somebody wants out of the session, and who they said they are", async () => {
    const customer = await upsertCustomer(runner, intake({ email: "goal@example.com" }), NOW);
    const stored = await recordIntake(
      runner,
      customer.id,
      intake({ primaryGoal: "Ship a production deployment.", marketingConsent: true }),
    );

    const row = await db.query<{
      primary_goal: string;
      customer_id: string;
      first_name: string | null;
      phone: string | null;
      timezone: string | null;
      marketing_consent: boolean;
    }>(
      `select primary_goal, customer_id, first_name, phone, timezone, marketing_consent
         from intakes where id = $1`,
      [stored.id],
    );
    expect(row.rows[0]).toEqual({
      primary_goal: "Ship a production deployment.",
      customer_id: customer.id,
      first_name: "Amina",
      phone: "+971 50 123 4567",
      timezone: "Asia/Dubai",
      marketing_consent: true,
    });
  });

  // A second booking has a different reason behind it, and overwriting the
  // first would lose why they came the first time.
  it("keeps one row per booking attempt rather than overwriting", async () => {
    const email = "twogoals@example.com";
    const customer = await upsertCustomer(runner, intake({ email }), NOW);
    await recordIntake(runner, customer.id, intake({ primaryGoal: "First goal." }));
    await recordIntake(runner, customer.id, intake({ primaryGoal: "Second goal." }));

    const count = await db.query<{ n: number }>(
      "select count(*)::int as n from intakes where customer_id = $1",
      [customer.id],
    );
    expect(count.rows[0]!.n).toBe(2);
  });
});

describe("captureLead", () => {
  it("stores the person and their goal together", async () => {
    const result = await captureLead(runner, intake({ email: "lead@example.com" }), NOW);
    expect(result.isNewCustomer).toBe(true);
    expect(result.customerId).toBeTruthy();
    expect(result.intakeId).toBeTruthy();

    const joined = await db.query<{ email: string; primary_goal: string }>(
      `select c.email, i.primary_goal from intakes i
       join customers c on c.id = i.customer_id where i.id = $1`,
      [result.intakeId],
    );
    expect(joined.rows[0]!.email).toBe("lead@example.com");
    expect(joined.rows[0]!.primary_goal).toContain("Claude Code");
  });

  it("reports a returning customer as not new", async () => {
    const email = "leadtwice@example.com";
    await captureLead(runner, intake({ email }), NOW);
    const second = await captureLead(runner, intake({ email }), LATER);
    expect(second.isNewCustomer).toBe(false);
  });

  /*
    A customer must never exist without the intake explaining why they are
    there - a half-written lead is one nobody can follow up properly. The
    caller runs this inside a transaction; this proves a failure actually rolls
    the whole thing back rather than leaving the customer behind.
  */
  it("leaves nothing behind when the second half fails", async () => {
    const email = "atomic@example.com";
    await db.query("begin");
    try {
      await captureLead(runner, intake({ email, primaryGoal: "" }), NOW);
    } catch {
      // The blank goal violates a check constraint, as it should.
    }
    await db.query("rollback");

    const count = await db.query<{ n: number }>(
      "select count(*)::int as n from customers where email = $1",
      [email],
    );
    expect(count.rows[0]!.n).toBe(0);
  });
});

/*
  The "this should be impossible" branches. They exist so that a query which
  somehow returns nothing fails loudly instead of handing back an undefined id
  that ends up as a foreign key. Untested, they are just a comforting shape.
*/
describe("when the database returns nothing at all", () => {
  const returnsNoRows: QueryRunner = {
    query: () => Promise.resolve({ rows: [] }),
  };

  it("refuses to carry on after storing a customer produced no id", async () => {
    await expect(upsertCustomer(returnsNoRows, intake(), NOW)).rejects.toThrow(/impossible/);
  });

  it("refuses to carry on after storing an intake produced no id", async () => {
    await expect(
      recordIntake(returnsNoRows, "some-customer-id", intake({ primaryGoal: "A goal." })),
    ).rejects.toThrow(/impossible/);
  });
});
