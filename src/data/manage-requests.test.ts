import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QueryRunner } from "./db";
import { findUpcomingBookingsForEmail } from "./manage-requests";
import { bookingReference } from "@/domain/booking/withdrawal";
import { addDays, addMinutes } from "@/lib/time";

/** Which bookings a "Manage my booking" request may email a link for. */

let db: PGlite;
let runner: QueryRunner;
let n = 0;
const NOW = new Date("2027-05-01T08:00:00.000Z");

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

async function customer(email: string) {
  const r = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [email],
  );
  return r.rows[0]!.id;
}

async function booking(customerId: string, start: Date, status = "confirmed") {
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid') returning id`,
    [customerId],
  );
  const b = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start,
                           scheduled_end, customer_timezone)
     values ($1, 'claude-claude-code', 1, $2, $3, $4, 'Asia/Dubai') returning id`,
    [order.rows[0]!.id, status, start, addMinutes(start, 90)],
  );
  return b.rows[0]!.id;
}

const day = () => {
  n += 1;
  return addDays(NOW, n * 2);
};

describe("findUpcomingBookingsForEmail", () => {
  it("finds the upcoming bookings for an address, whatever its case, soonest first", async () => {
    const c = await customer("upcoming1@example.com");
    const later = await booking(c, day());
    const sooner = await booking(c, addDays(NOW, 1));

    const found = await findUpcomingBookingsForEmail(runner, {
      email: "  UPCOMING1@example.com ",
      reference: null,
      now: NOW,
    });

    expect(found.map((b) => b.bookingId)).toEqual([sooner, later]);
    expect(found[0]).toMatchObject({ firstName: "Amina", customerTimezone: "Asia/Dubai" });
  });

  it("leaves out past, cancelled and unpaid-for bookings", async () => {
    const c = await customer("upcoming2@example.com");
    await booking(c, addDays(NOW, -1));
    await booking(c, day(), "cancelled");
    await booking(c, day(), "completed");

    expect(
      await findUpcomingBookingsForEmail(runner, {
        email: "upcoming2@example.com",
        reference: null,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("narrows to one booking when the reference is given", async () => {
    const c = await customer("upcoming3@example.com");
    const wanted = await booking(c, day());
    await booking(c, day());

    const found = await findUpcomingBookingsForEmail(runner, {
      email: "upcoming3@example.com",
      reference: bookingReference(wanted),
      now: NOW,
    });
    expect(found.map((b) => b.bookingId)).toEqual([wanted]);
  });

  it("finds nothing for somebody else's address, even with the right reference", async () => {
    const c = await customer("upcoming4@example.com");
    const theirs = await booking(c, day());
    await customer("stranger@example.com");

    expect(
      await findUpcomingBookingsForEmail(runner, {
        email: "stranger@example.com",
        reference: bookingReference(theirs),
        now: NOW,
      }),
    ).toEqual([]);
  });
});
