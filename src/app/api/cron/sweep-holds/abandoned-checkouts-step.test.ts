import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { QueryRunner } from "@/data/db";
import { MockPaymentProvider } from "@/domain/payments/mock-provider";
import { resetLogSink, setLogSink } from "@/lib/logger";
import { endAbandonedCheckouts } from "./abandoned-checkouts-step";

/**
 * A customer with two tabs: starting the second checkout gave up the first
 * one's time, and the first checkout must not stay payable (audit s101 P10).
 * The sweep keeps asking Stripe to end it while it can live.
 */

let db: PGlite;
let n = 0;
const NOW = new Date("2027-06-01T10:00:00Z");
const transaction = <T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> =>
  db.transaction((tx) => work(tx as unknown as QueryRunner));

beforeAll(async () => {
  db = await PGlite.create();
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(() => {
  setLogSink(() => undefined);
  return () => resetLogSink();
});

/** A pending order with its checkout, and a hold in the given state. */
async function pendingCheckout(
  hold: "released" | "held" | "expired",
  createdMinutesAgo = 10,
): Promise<string> {
  n += 1;
  const created = new Date(NOW.getTime() - createdMinutesAgo * 60_000);
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`tabs${n}@example.com`],
  );
  const session = `cs_tab_${n}`;
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_checkout_session_id, created_at, updated_at)
     values ($1, 'single', 'ai-foundations', 129900, 'pending', $2, $3, $3) returning id`,
    [customer.rows[0]!.id, session, created],
  );
  const start = new Date(Date.UTC(2027, 6, 1, 10) + n * 3 * 60 * 60_000);
  await db.query(
    `insert into slot_holds (slot_start, slot_end, order_id, expires_at, status)
     values ($1, $2, $3, $4, $5)`,
    [start, new Date(start.getTime() + 60 * 60_000), order.rows[0]!.id, NOW, hold],
  );
  return session;
}

describe("endAbandonedCheckouts", () => {
  it("ends a checkout whose time was given up, and leaves one still holding its time", async () => {
    const givenUp = await pendingCheckout("released");
    const live = await pendingCheckout("held");
    const provider = new MockPaymentProvider();

    const report = await endAbandonedCheckouts({
      provider: () => provider,
      transaction,
      clock: () => NOW,
    });

    expect(report).toEqual({ ended: 1, failed: 0 });
    expect(provider.expired).toContain(givenUp);
    expect(provider.expired).not.toContain(live);
  });

  /*
    A hold that merely expired is not a time given up: a late payment may still
    retake it (the late-payment rescue), so its checkout is left to Stripe.
  */
  it("leaves a checkout whose hold only expired", async () => {
    const expired = await pendingCheckout("expired");
    const provider = new MockPaymentProvider();

    await endAbandonedCheckouts({ provider: () => provider, transaction, clock: () => NOW });

    expect(provider.expired).not.toContain(expired);
  });

  it("stops asking once the checkout is past the time it could live", async () => {
    const old = await pendingCheckout("released", 90);
    const provider = new MockPaymentProvider();

    await endAbandonedCheckouts({ provider: () => provider, transaction, clock: () => NOW });

    expect(provider.expired).not.toContain(old);
  });

  it("counts a refusal and carries on, so the next run asks again", async () => {
    await pendingCheckout("released");
    const provider = new MockPaymentProvider();
    provider.expireCheckout = () => Promise.reject(new Error("stripe down"));

    const report = await endAbandonedCheckouts({
      provider: () => provider,
      transaction,
      clock: () => NOW,
    });

    expect(report).toMatchObject({ ended: 0 });
    expect((report as { failed: number }).failed).toBeGreaterThan(0);
  });
});
