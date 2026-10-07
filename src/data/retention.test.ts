import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import { purgeExpiredPersonalData } from "./retention";

/**
 * The privacy notice's promises about how long data is kept, kept by code:
 * a booking started but not paid, 30 days; questionnaire answers, 12 months
 * after the last session; IP addresses in security records, a few days;
 * bookings, payments and what was agreed, 7 years after the end of the tax
 * year. Each test plants data on both sides of the line.
 */

let db: PGlite;
let runner: QueryRunner;
let n = 0;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2027-06-15T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

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

async function customer(createdAt: Date): Promise<string> {
  const row = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone, created_at, updated_at)
     values ('Amina', 'Khan', $1, 'Asia/Dubai', $2, $2) returning id`,
    [`keep${++n}@example.com`, createdAt],
  );
  return row.rows[0]!.id;
}

async function intake(customerId: string, createdAt: Date): Promise<string> {
  const row = await db.query<{ id: string }>(
    `insert into intakes (customer_id, primary_goal, created_at) values ($1, 'A goal', $2) returning id`,
    [customerId, createdAt],
  );
  return row.rows[0]!.id;
}

/** An order with one booking; a paid one gets a session ending at `sessionEnd`. */
async function order(
  customerId: string,
  createdAt: Date,
  paymentStatus: string,
  sessionEnd: Date | null = null,
): Promise<{ orderId: string; bookingId: string }> {
  const o = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status, created_at)
     values ($1, 'single', 'claude-claude-code', 149900, $2, $3) returning id`,
    [customerId, paymentStatus, createdAt],
  );
  const orderId = o.rows[0]!.id;
  const start = sessionEnd === null ? null : new Date(sessionEnd.getTime() - 90 * 60_000);
  const b = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end,
                           customer_timezone, created_at)
     values ($1, 'claude-claude-code', 1, $2, $3, $4, 'Asia/Dubai', $5) returning id`,
    [orderId, start === null ? "awaiting_schedule" : "completed", start, sessionEnd, createdAt],
  );
  await db.query(
    `insert into booking_consents (order_id, terms_version, key_terms, agreement_text,
       within_cancellation_period, express_request, text_sha256, accepted_at)
     values ($1, 'v', 'k', 'a', false, false, $2, $3)`,
    [orderId, "0".repeat(64), createdAt],
  );
  return { orderId, bookingId: b.rows[0]!.id };
}

const exists = async (table: string, id: string) =>
  (await db.query(`select 1 from ${table} where id = $1`, [id])).rows.length === 1;

describe("a booking started but not paid", () => {
  it("is deleted after 30 days, with its consent record, and the person if nothing else is theirs", async () => {
    const c = await customer(ago(40));
    const { orderId, bookingId } = await order(c, ago(31), "pending");
    await purgeExpiredPersonalData(runner, NOW);
    expect(await exists("orders", orderId)).toBe(false);
    expect(await exists("bookings", bookingId)).toBe(false);
    expect(
      (await db.query(`select 1 from booking_consents where order_id = $1`, [orderId])).rows,
    ).toHaveLength(0);
    expect(await exists("customers", c)).toBe(false);
  });

  it("is kept for the first 30 days", async () => {
    const c = await customer(ago(40));
    const { orderId } = await order(c, ago(29), "failed");
    await purgeExpiredPersonalData(runner, NOW);
    expect(await exists("orders", orderId)).toBe(true);
    expect(await exists("customers", c)).toBe(true);
  });

  it("keeps the person when they also have a paid booking", async () => {
    const c = await customer(ago(400));
    const paid = await order(c, ago(300), "paid", ago(290));
    const unpaid = await order(c, ago(60), "pending");
    await purgeExpiredPersonalData(runner, NOW);
    expect(await exists("orders", unpaid.orderId)).toBe(false);
    expect(await exists("orders", paid.orderId)).toBe(true);
    expect(await exists("customers", c)).toBe(true);
  });

  it("deletes somebody who gave details but never reached payment, after 30 days", async () => {
    const old = await customer(ago(31));
    await intake(old, ago(31));
    const recent = await customer(ago(5));
    await purgeExpiredPersonalData(runner, NOW);
    expect(await exists("customers", old)).toBe(false);
    expect(await exists("customers", recent)).toBe(true);
  });
});

describe("questionnaire answers", () => {
  it("are deleted 12 months after the last session", async () => {
    const c = await customer(ago(800));
    const i = await intake(c, ago(800));
    await order(c, ago(800), "paid", ago(366));
    await purgeExpiredPersonalData(runner, NOW);
    expect(await exists("intakes", i)).toBe(false);
    expect(await exists("customers", c)).toBe(true);
  });

  it("are kept while the last session is under 12 months ago", async () => {
    const c = await customer(ago(800));
    const i = await intake(c, ago(800));
    await order(c, ago(800), "paid", ago(500));
    await order(c, ago(200), "paid", ago(100));
    await purgeExpiredPersonalData(runner, NOW);
    expect(await exists("intakes", i)).toBe(true);
  });

  it("are kept while a paid booking still waits for a time", async () => {
    const c = await customer(ago(800));
    const i = await intake(c, ago(800));
    await order(c, ago(800), "paid", ago(500));
    await order(c, ago(400), "paid", null);
    await purgeExpiredPersonalData(runner, NOW);
    expect(await exists("intakes", i)).toBe(true);
  });
});

describe("IP addresses on slot holds", () => {
  it("are removed from finished holds after 7 days, kept on live and recent ones", async () => {
    const hold = async (createdAt: Date, status: string, startDays: number) =>
      (
        await db.query<{ id: string }>(
          `insert into slot_holds (slot_start, slot_end, expires_at, status, client_address, created_at)
           values ($1, $2, $3, $4, '203.0.113.9', $5) returning id`,
          [
            new Date(NOW.getTime() + startDays * DAY),
            new Date(NOW.getTime() + startDays * DAY + 90 * 60_000),
            new Date(createdAt.getTime() + 30 * 60_000),
            status,
            createdAt,
          ],
        )
      ).rows[0]!.id;
    const old = await hold(ago(8), "expired", 100);
    const recent = await hold(ago(2), "released", 101);
    const live = await hold(ago(8), "held", 102);
    await purgeExpiredPersonalData(runner, NOW);
    const address = async (id: string) =>
      (
        await db.query<{ a: string | null }>(
          `select client_address as a from slot_holds where id = $1`,
          [id],
        )
      ).rows[0]?.a;
    expect(await address(old)).toBeNull();
    expect(await address(recent)).toBe("203.0.113.9");
    expect(await address(live)).toBe("203.0.113.9");
  });
});

describe("bookings, payments and what was agreed", () => {
  it("are deleted 7 years after the end of the tax year of the last order", async () => {
    // Last order in 2019: kept to the end of 2026, gone in 2027.
    const c = await customer(new Date("2019-03-01T00:00:00Z"));
    const { orderId, bookingId } = await order(
      c,
      new Date("2019-03-01T00:00:00Z"),
      "paid",
      new Date("2019-03-10T00:00:00Z"),
    );
    await db.query(
      `insert into withdrawal_requests (booking_id, full_name, email, statement, refund_due_fils, received_at)
       values ($1, 'Amina Khan', $2, 'I withdraw.', 0, '2019-03-02T00:00:00Z')`,
      [bookingId, `keep${n}@example.com`],
    );
    await purgeExpiredPersonalData(runner, NOW);
    expect(await exists("orders", orderId)).toBe(false);
    expect(await exists("bookings", bookingId)).toBe(false);
    expect(await exists("customers", c)).toBe(false);
  });

  it("are kept through the seventh year", async () => {
    // Last order in 2020: kept to the end of 2027.
    const c = await customer(new Date("2020-12-31T00:00:00Z"));
    const { orderId } = await order(
      c,
      new Date("2020-12-31T00:00:00Z"),
      "paid",
      new Date("2021-01-10T00:00:00Z"),
    );
    await purgeExpiredPersonalData(runner, NOW);
    expect(await exists("orders", orderId)).toBe(true);
  });

  it("count from the person's most recent order, not the oldest", async () => {
    const c = await customer(new Date("2018-01-01T00:00:00Z"));
    const oldOrder = await order(
      c,
      new Date("2018-01-01T00:00:00Z"),
      "paid",
      new Date("2018-01-10T00:00:00Z"),
    );
    await order(c, new Date("2026-01-01T00:00:00Z"), "paid", new Date("2026-01-10T00:00:00Z"));
    await purgeExpiredPersonalData(runner, NOW);
    expect(await exists("orders", oldOrder.orderId)).toBe(true);
    expect(await exists("customers", c)).toBe(true);
  });
});

it("reports what it removed and is a no-op when run again", async () => {
  const c = await customer(ago(40));
  await order(c, ago(31), "pending");
  const first = await purgeExpiredPersonalData(runner, NOW);
  expect(first.unpaidOrders).toBeGreaterThanOrEqual(1);
  const second = await purgeExpiredPersonalData(runner, NOW);
  expect(second).toEqual({
    unpaidOrders: 0,
    customers: 0,
    intakes: 0,
    holdAddresses: 0,
    expiredRecords: 0,
  });
});
