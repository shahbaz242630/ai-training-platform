import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QueryRunner } from "./db";
import { findBookingForWithdrawal, loadWithdrawal, recordWithdrawal } from "./withdrawals";
import { bookingReference } from "@/domain/booking/withdrawal";

/**
 * The notice a UK or EU customer gives to withdraw, and what it does: kept
 * once and never edited, the booking closed, everything still owed to it
 * withdrawn, and the acknowledgement the law asks for queued straight away.
 */

let db: PGlite;
let runner: QueryRunner;
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

interface Seeded {
  readonly bookingId: string;
  readonly email: string;
  readonly reference: string;
}

async function seed(
  over: { status?: string; paymentStatus?: string; start?: string | null } = {},
): Promise<Seeded> {
  const email = `withdraw${++n}@example.com`;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Europe/London') returning id`,
    [email],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'claude-claude-code', 149900, $2) returning id`,
    [customer.rows[0]!.id, over.paymentStatus ?? "paid"],
  );
  // Each booking on its own day: the database refuses two sessions at once.
  const start =
    over.start === undefined ? new Date(Date.UTC(2026, 10, 1 + n, 15)).toISOString() : over.start;
  const status = over.status ?? (start === null ? "awaiting_schedule" : "confirmed");
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start,
                           scheduled_end, customer_timezone)
     values ($1, 'claude-claude-code', 1, $2, $3,
             case when $3::timestamptz is null then null else $3::timestamptz + interval '90 minutes' end,
             'Europe/London')
     returning id`,
    [order.rows[0]!.id, status, start],
  );
  const bookingId = booking.rows[0]!.id;
  return { bookingId, email, reference: bookingReference(bookingId) };
}

async function queue(bookingId: string, templateKey: string): Promise<void> {
  await db.query(
    `insert into communication_log (booking_id, channel, template_key, status, scheduled_for)
     values ($1, 'email', $2, 'queued', now() + interval '1 day')`,
    [bookingId, templateKey],
  );
}

const input = (s: Seeded, over: Partial<Parameters<typeof recordWithdrawal>[1]> = {}) => ({
  bookingId: s.bookingId,
  fullName: "Amina Khan",
  email: s.email,
  statement: "I, Amina Khan, withdraw from my contract.",
  refundDueFils: 149900,
  receivedAt: new Date("2026-10-07T09:00:00Z"),
  ipAddress: "203.0.113.9",
  userAgent: "test",
  ...over,
});

describe("findBookingForWithdrawal", () => {
  it("finds a booking by its reference and the email it was booked with", async () => {
    const s = await seed();
    const found = await findBookingForWithdrawal(runner, s.reference, s.email);
    expect(found).toMatchObject({
      bookingId: s.bookingId,
      bookingStatus: "confirmed",
      paymentStatus: "paid",
      sessionSlug: "claude-claude-code",
      amountPaidFils: 149900,
      customerTimezone: "Europe/London",
      withdrawal: null,
    });
    expect(found?.scheduledStart).toBeInstanceOf(Date);
    expect(found?.bookedAt).toBeInstanceOf(Date);
  });

  it("matches the email whatever its case", async () => {
    const s = await seed();
    expect(
      await findBookingForWithdrawal(runner, s.reference, s.email.toUpperCase()),
    ).not.toBeNull();
  });

  it("finds nothing with the right reference and somebody else's email", async () => {
    const s = await seed();
    const other = await seed();
    expect(await findBookingForWithdrawal(runner, s.reference, other.email)).toBeNull();
  });

  it("finds nothing with the right email and a wrong reference", async () => {
    const s = await seed();
    const wrong = s.reference === "00000000" ? "11111111" : "00000000";
    expect(await findBookingForWithdrawal(runner, wrong, s.email)).toBeNull();
  });
});

describe("recordWithdrawal", () => {
  it("keeps the notice, closes the booking and queues the acknowledgement", async () => {
    const s = await seed();
    const result = await recordWithdrawal(runner, input(s));
    expect(result).toEqual({
      created: true,
      receivedAt: new Date("2026-10-07T09:00:00Z"),
      refundDueFils: 149900,
    });

    const booking = await db.query<{ status: string }>(
      `select status from bookings where id = $1`,
      [s.bookingId],
    );
    expect(booking.rows[0]?.status).toBe("cancelled");

    const ack = await db.query<{ status: string }>(
      `select status from communication_log
        where booking_id = $1 and template_key = 'withdrawal_acknowledgement'`,
      [s.bookingId],
    );
    expect(ack.rows).toEqual([{ status: "queued" }]);
  });

  it("withdraws the reminders still owed to the booking, but not the acknowledgement", async () => {
    const s = await seed();
    await queue(s.bookingId, "reminder_24h");
    await queue(s.bookingId, "follow_up");
    await recordWithdrawal(runner, input(s));
    const rows = await db.query<{ template_key: string; status: string }>(
      `select template_key, status from communication_log where booking_id = $1 order by template_key`,
      [s.bookingId],
    );
    expect(rows.rows).toEqual([
      { template_key: "follow_up", status: "cancelled" },
      { template_key: "reminder_24h", status: "cancelled" },
      { template_key: "withdrawal_acknowledgement", status: "queued" },
    ]);
  });

  it("treats a second confirmation as the same notice: no second record, no second email", async () => {
    const s = await seed();
    await recordWithdrawal(runner, input(s));
    const again = await recordWithdrawal(
      runner,
      input(s, { receivedAt: new Date("2026-10-07T09:05:00Z"), refundDueFils: 1 }),
    );
    expect(again).toEqual({
      created: false,
      receivedAt: new Date("2026-10-07T09:00:00Z"),
      refundDueFils: 149900,
    });
    const count = await db.query<{ n: number }>(
      `select count(*)::int as n from withdrawal_requests where booking_id = $1`,
      [s.bookingId],
    );
    expect(count.rows[0]?.n).toBe(1);
  });

  it("closes a booking still waiting for a time", async () => {
    const s = await seed({ start: null });
    await recordWithdrawal(runner, input(s));
    const booking = await db.query<{ status: string }>(
      `select status from bookings where id = $1`,
      [s.bookingId],
    );
    expect(booking.rows[0]?.status).toBe("cancelled");
  });

  it("is never edited once kept", async () => {
    const s = await seed();
    await recordWithdrawal(runner, input(s));
    await expect(
      db.query(`update withdrawal_requests set refund_due_fils = 0 where booking_id = $1`, [
        s.bookingId,
      ]),
    ).rejects.toThrow(/cannot be edited/);
  });

  it("shows on the next lookup, so the form can say it was already received", async () => {
    const s = await seed();
    await recordWithdrawal(runner, input(s));
    const found = await findBookingForWithdrawal(runner, s.reference, s.email);
    expect(found?.withdrawal).toEqual({
      receivedAt: new Date("2026-10-07T09:00:00Z"),
      refundDueFils: 149900,
    });
  });
});

describe("loadWithdrawal", () => {
  it("returns what the acknowledgement email states", async () => {
    const s = await seed();
    await recordWithdrawal(runner, input(s));
    expect(await loadWithdrawal(runner, s.bookingId)).toEqual({
      fullName: "Amina Khan",
      statement: "I, Amina Khan, withdraw from my contract.",
      refundDueFils: 149900,
      receivedAt: new Date("2026-10-07T09:00:00Z"),
    });
  });

  it("returns null for a booking with no withdrawal", async () => {
    const s = await seed();
    expect(await loadWithdrawal(runner, s.bookingId)).toBeNull();
  });
});
