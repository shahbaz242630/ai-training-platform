import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import { findStuckWork } from "./health";

/**
 * The signs that the sweep runs but something it depends on has quietly
 * stopped: each only once it has lasted two hours, so one bad minute never
 * raises the monitor's alarm.
 */

let db: PGlite;
let runner: QueryRunner;
const NOW = new Date("2027-05-01T12:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

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
  await db.exec(
    `delete from refunds; delete from desk_alerts; delete from communication_log;
     delete from bookings; delete from orders; delete from customers;`,
  );
});

async function booking(): Promise<{ orderId: string; bookingId: string }> {
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', 'health@example.com', 'Asia/Dubai') returning id`,
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'ai-foundations', 129900, 'paid') returning id`,
    [customer.rows[0]!.id],
  );
  const b = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, customer_timezone)
     values ($1, 'ai-foundations', 1, 'awaiting_schedule', 'Asia/Dubai') returning id`,
    [order.rows[0]!.id],
  );
  return { orderId: order.rows[0]!.id, bookingId: b.rows[0]!.id };
}

describe("findStuckWork", () => {
  it("finds nothing when everything is moving", async () => {
    expect(await findStuckWork(runner, NOW)).toEqual([]);
  });

  it("finds a desk alert never sent after two hours: the desk's email is down", async () => {
    await db.query(
      `insert into desk_alerts (kind, subject_key, first_raised_at, created_at, updated_at)
       values ('refund_needs_attention', 'refund:recent', $1, $1, $1),
              ('refund_needs_attention', 'refund:old', $2, $2, $2)`,
      [ago(30), ago(121)],
    );
    expect(await findStuckWork(runner, NOW)).toEqual(["desk_alerts_unsent"]);
  });

  it("ignores an old alert that was sent: reminders are its business", async () => {
    await db.query(
      `insert into desk_alerts (kind, subject_key, first_raised_at, created_at, updated_at, sends, last_sent_at)
       values ('refund_needs_attention', 'refund:sent', $1, $1, $1, 1, $1)`,
      [ago(600)],
    );
    expect(await findStuckWork(runner, NOW)).toEqual([]);
  });

  it("finds customer emails more than two hours overdue, not ones just due", async () => {
    const { bookingId } = await booking();
    await db.query(
      `insert into communication_log (booking_id, channel, template_key, status, scheduled_for)
       values ($1, 'email', 'reminder_24h', 'queued', $2)`,
      [bookingId, ago(60)],
    );
    expect(await findStuckWork(runner, NOW)).toEqual([]);
    await db.query(
      `insert into communication_log (booking_id, channel, template_key, status, scheduled_for)
       values ($1, 'email', 'reminder_3h', 'queued', $2)`,
      [bookingId, ago(130)],
    );
    expect(await findStuckWork(runner, NOW)).toEqual(["customer_emails_overdue"]);
  });

  it("finds a refund owed and not issued after two hours", async () => {
    const { orderId } = await booking();
    await db.query(
      `insert into refunds (order_id, origin, amount_fils, currency, status, created_at, updated_at)
       values ($1, 'processor', 129900, 'AED', 'due', $2, $2)`,
      [orderId, ago(125)],
    );
    expect(await findStuckWork(runner, NOW)).toEqual(["refunds_overdue"]);
  });
});
