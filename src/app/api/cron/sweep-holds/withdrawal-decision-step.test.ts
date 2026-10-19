import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { QueryRunner } from "@/data/db";
import { declineWithdrawal, recordWithdrawal } from "@/data/withdrawals";
import { MockEmailProvider } from "@/domain/messaging/mock-provider";
import { withdrawalDecisionAlerts } from "./withdrawal-decision-step";

/**
 * Withdrawals the desk decides, as the sweep runs them: one email to the desk
 * per notice, once a day while it waits, and quiet once the payment is
 * refunded in the dashboard, which is how the desk approves.
 */

let db: PGlite;
let runner: QueryRunner;
let mail: MockEmailProvider;
const RECEIVED = new Date("2026-10-19T08:00:00Z");
const DAY = 24 * 60 * 60_000;
const DESK = "desk@example.com";
let n = 0;

beforeAll(async () => {
  db = await PGlite.create();
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  runner = db as unknown as QueryRunner;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  // Each test starts with nothing waiting: an earlier test's notices count as approved.
  await db.query(`update orders set payment_status = 'refunded'`);
  await db.query(`delete from desk_alerts`);
  mail = new MockEmailProvider();
});

const run = (now: Date) =>
  withdrawalDecisionAlerts({
    transaction: (work) => db.transaction((tx) => work(tx as unknown as QueryRunner)),
    email: () => mail,
    clock: () => now,
    desk: () => DESK,
    declineUrl: (bookingId) => `https://example.test/decline/${bookingId}`,
  });

/** A paid, confirmed booking with a notice kept on the given route. */
async function noticed(
  route: "automatic" | "desk",
): Promise<{ bookingId: string; orderId: string }> {
  n += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`desk-step${n}@example.com`],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_payment_intent_id)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid', $2) returning id`,
    [customer.rows[0]!.id, `pi_desk_step_${n}`],
  );
  const start = new Date(Date.UTC(2026, 11, 1, 10) + n * 3 * 60 * 60_000);
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end,
                           customer_timezone)
     values ($1, 'claude-claude-code', 1, 'confirmed', $2, $3, 'Asia/Dubai') returning id`,
    [order.rows[0]!.id, start, new Date(start.getTime() + 90 * 60_000)],
  );
  const bookingId = booking.rows[0]!.id;
  await recordWithdrawal(runner, {
    bookingId,
    fullName: "Amina Khan",
    email: `desk-step${n}@example.com`,
    statement: "I, Amina Khan, withdraw from my contract.",
    refundDueFils: 149900,
    receivedAt: RECEIVED,
    ipAddress: null,
    userAgent: null,
    route,
    cardCountry: route === "desk" ? "AE" : "GB",
  });
  return { bookingId, orderId: order.rows[0]!.id };
}

describe("withdrawalDecisionAlerts", () => {
  it("emails the desk once about a notice it must decide, and not about one refunded automatically", async () => {
    await noticed("desk");
    await noticed("automatic");
    const report = await run(new Date(RECEIVED.getTime() + 60_000));
    expect(report).toMatchObject({ raised: 1, waiting: 1 });
    expect(mail.sent.map((m) => m.to)).toEqual([DESK]);
    expect(mail.sent[0]?.text).toContain("https://example.test/decline/");
    expect(mail.sent[0]?.subject).toMatch(
      /^Withdrawal to decide: booking [0-9A-F]{8}, AED 1,499, card AE$/,
    );
  });

  it("reminds the next day, and goes quiet once the payment is refunded", async () => {
    const { orderId } = await noticed("desk");
    await run(new Date(RECEIVED.getTime() + 60_000));
    const reminded = await run(new Date(RECEIVED.getTime() + DAY + 60_000));
    expect(reminded).toMatchObject({ reminded: 1 });

    await db.query(`update orders set payment_status = 'refunded' where id = $1`, [orderId]);
    const after = await run(new Date(RECEIVED.getTime() + DAY + 120_000));
    expect(after).toMatchObject({ resolved: 1, waiting: 0 });
  });

  it("goes quiet once the desk records a decline", async () => {
    const { bookingId } = await noticed("desk");
    await run(new Date(RECEIVED.getTime() + 60_000));
    await declineWithdrawal(runner, bookingId, new Date(RECEIVED.getTime() + 90_000));
    const after = await run(new Date(RECEIVED.getTime() + 120_000));
    expect(after).toMatchObject({ resolved: 1, waiting: 0 });
  });

  it("reports an email failure as its own, without throwing", async () => {
    await noticed("desk");
    const report = await withdrawalDecisionAlerts({
      transaction: (work) => db.transaction((tx) => work(tx as unknown as QueryRunner)),
      email: () => mail,
      clock: () => new Date(RECEIVED.getTime() + 60_000),
      desk: () => {
        throw new Error("no desk address configured");
      },
      declineUrl: () => null,
    });
    expect(report).toEqual({ error: "desk alerts could not be sent" });
  });
});
