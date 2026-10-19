import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { QueryRunner } from "./db";
import {
  findBookingForWithdrawal,
  declineWithdrawal,
  listWithdrawalsForDesk,
  loadWithdrawal,
  recordWithdrawal,
} from "./withdrawals";
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
  route: "automatic" as const,
  cardCountry: "GB",
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
      bookingsOnOrder: 1,
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
      route: "automatic",
      declined: false,
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
      route: "automatic",
      declined: false,
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
      route: "automatic",
      declined: false,
    });
  });
});

describe("the refund a withdrawal is owed", () => {
  const refundsFor = async (bookingId: string) =>
    (
      await db.query<{ status: string; amount_fils: string | number; origin: string }>(
        `select r.status, r.amount_fils, r.origin
           from refunds r join withdrawal_requests w on w.id = r.withdrawal_request_id
          where w.booking_id = $1`,
        [bookingId],
      )
    ).rows.map((r) => ({ ...r, amount_fils: Number(r.amount_fils) }));

  it("is written with the notice, in full, due for the sweep to send", async () => {
    const s = await seed();
    await recordWithdrawal(runner, input(s));
    expect(await refundsFor(s.bookingId)).toEqual([
      { status: "due", amount_fils: 149900, origin: "withdrawal" },
    ]);
  });

  it("is written once, however often the notice is confirmed", async () => {
    const s = await seed();
    await recordWithdrawal(runner, input(s));
    await recordWithdrawal(runner, input(s, { receivedAt: new Date("2026-10-07T09:05:00Z") }));
    expect(await refundsFor(s.bookingId)).toHaveLength(1);
  });

  // The notice is kept either way; money goes back only for a booking this notice closed.
  it("is not written when the booking was no longer open to cancel", async () => {
    const s = await seed({ status: "completed" });
    await recordWithdrawal(runner, input(s));
    expect(await refundsFor(s.bookingId)).toEqual([]);
  });

  it("is not written when nothing is due", async () => {
    const s = await seed();
    await recordWithdrawal(runner, input(s, { refundDueFils: 0 }));
    expect(await refundsFor(s.bookingId)).toEqual([]);
  });

  it("can lock the order while the notice is decided", async () => {
    const s = await seed();
    const found = await findBookingForWithdrawal(runner, s.reference, s.email, { lock: true });
    expect(found?.bookingId).toBe(s.bookingId);
  });
});

describe("the withdrawn session's time", () => {
  it("goes back on sale: the hold that kept it is released", async () => {
    const s = await seed();
    const b = await db.query<{ order_id: string; scheduled_start: Date; scheduled_end: Date }>(
      `select order_id, scheduled_start, scheduled_end from bookings where id = $1`,
      [s.bookingId],
    );
    const row = b.rows[0]!;
    const hold = await db.query<{ id: string }>(
      `insert into slot_holds (slot_start, slot_end, order_id, expires_at, status)
       values ($1, $2, $3, $1, 'converted') returning id`,
      [row.scheduled_start, row.scheduled_end, row.order_id],
    );
    await recordWithdrawal(runner, input(s));
    const after = await db.query<{ status: string }>(
      `select status from slot_holds where id = $1`,
      [hold.rows[0]!.id],
    );
    expect(after.rows[0]?.status).toBe("released");
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
      route: "automatic",
      declined: false,
    });
  });

  it("returns null for a booking with no withdrawal", async () => {
    const s = await seed();
    expect(await loadWithdrawal(runner, s.bookingId)).toBeNull();
  });
});

describe("a notice the desk decides", () => {
  const desk = (s: Seeded) => input(s, { route: "desk", cardCountry: "AE" });

  it("is kept, with the card's country and the route, and acknowledged", async () => {
    const s = await seed();
    const result = await recordWithdrawal(runner, desk(s));
    expect(result).toEqual({
      created: true,
      receivedAt: new Date("2026-10-07T09:00:00Z"),
      refundDueFils: 149900,
      route: "desk",
      declined: false,
    });
    const row = await db.query<{ route: string; card_country: string | null }>(
      `select route, card_country from withdrawal_requests where booking_id = $1`,
      [s.bookingId],
    );
    expect(row.rows).toEqual([{ route: "desk", card_country: "AE" }]);
    const ack = await db.query<{ status: string }>(
      `select status from communication_log
        where booking_id = $1 and template_key = 'withdrawal_acknowledgement'`,
      [s.bookingId],
    );
    expect(ack.rows).toEqual([{ status: "queued" }]);
  });

  it("leaves the booking, its reminders and its time exactly as they were", async () => {
    const s = await seed();
    await queue(s.bookingId, "reminder_24h");
    const b = await db.query<{ order_id: string; scheduled_start: Date; scheduled_end: Date }>(
      `select order_id, scheduled_start, scheduled_end from bookings where id = $1`,
      [s.bookingId],
    );
    const slot = b.rows[0]!;
    const hold = await db.query<{ id: string }>(
      `insert into slot_holds (slot_start, slot_end, order_id, expires_at, status)
       values ($1, $2, $3, $1, 'converted') returning id`,
      [slot.scheduled_start, slot.scheduled_end, slot.order_id],
    );

    await recordWithdrawal(runner, desk(s));

    const booking = await db.query<{ status: string }>(
      `select status from bookings where id = $1`,
      [s.bookingId],
    );
    expect(booking.rows[0]?.status).toBe("confirmed");
    const reminder = await db.query<{ status: string }>(
      `select status from communication_log
        where booking_id = $1 and template_key = 'reminder_24h'`,
      [s.bookingId],
    );
    expect(reminder.rows[0]?.status).toBe("queued");
    const held = await db.query<{ status: string }>(`select status from slot_holds where id = $1`, [
      hold.rows[0]!.id,
    ]);
    expect(held.rows[0]?.status).toBe("converted");
  });

  it("moves no money: no refund is written for the sweep", async () => {
    const s = await seed();
    await recordWithdrawal(runner, desk(s));
    const refunds = await db.query<{ n: number }>(
      `select count(*)::int as n
         from refunds r join withdrawal_requests w on w.id = r.withdrawal_request_id
        where w.booking_id = $1`,
      [s.bookingId],
    );
    expect(refunds.rows[0]?.n).toBe(0);
  });

  it("stays the desk's however often it is confirmed, even if a later look found a UK card", async () => {
    const s = await seed();
    await recordWithdrawal(runner, desk(s));
    const again = await recordWithdrawal(runner, input(s, { cardCountry: "GB" }));
    expect(again).toMatchObject({ created: false, route: "desk" });
    const booking = await db.query<{ status: string }>(
      `select status from bookings where id = $1`,
      [s.bookingId],
    );
    expect(booking.rows[0]?.status).toBe("confirmed");
  });

  it("shows on the next lookup as the desk's", async () => {
    const s = await seed();
    await recordWithdrawal(runner, desk(s));
    const found = await findBookingForWithdrawal(runner, s.reference, s.email);
    expect(found?.withdrawal?.route).toBe("desk");
    expect(found?.paymentIntentId).toBeNull();
  });

  it("refuses a card country that is not two capital letters", async () => {
    const s = await seed();
    await expect(
      recordWithdrawal(runner, input(s, { route: "desk", cardCountry: "uae" })),
    ).rejects.toThrow();
  });
});

describe("listWithdrawalsForDesk", () => {
  const RECEIVED = new Date("2026-10-07T09:00:00Z");
  const DAYS = (d: number) => new Date(RECEIVED.getTime() + d * 24 * 3_600_000);
  const listed = async (now: Date) =>
    (await listWithdrawalsForDesk(runner, now)).map((w) => w.bookingId);

  it("lists a notice the desk has not yet decided, with what the alert needs", async () => {
    const s = await seed({ start: "2026-12-01T15:00:00Z" });
    await recordWithdrawal(runner, input(s, { route: "desk", cardCountry: "AE" }));
    const found = (await listWithdrawalsForDesk(runner, DAYS(1))).find(
      (w) => w.bookingId === s.bookingId,
    );
    expect(found).toEqual({
      bookingId: s.bookingId,
      sessionSlug: "claude-claude-code",
      scheduledStart: new Date("2026-12-01T15:00:00Z"),
      receivedAt: RECEIVED,
      cardCountry: "AE",
      amountFils: 149900,
      paymentIntentId: null,
    });
  });

  it("never lists a notice refunded automatically", async () => {
    const s = await seed({ start: "2026-12-02T15:00:00Z" });
    await recordWithdrawal(runner, input(s));
    expect(await listed(DAYS(1))).not.toContain(s.bookingId);
  });

  it("stops listing it once the payment is refunded: the approval", async () => {
    const s = await seed({ start: "2026-12-03T15:00:00Z" });
    await recordWithdrawal(runner, input(s, { route: "desk", cardCountry: "AE" }));
    await db.query(
      `update orders set payment_status = 'refunded'
        where id = (select order_id from bookings where id = $1)`,
      [s.bookingId],
    );
    expect(await listed(DAYS(1))).not.toContain(s.bookingId);
  });

  it("keeps listing it after the session begins, until the refund days are over", async () => {
    const soon = await seed({ start: DAYS(3).toISOString() });
    await recordWithdrawal(runner, input(soon, { route: "desk", cardCountry: "AE" }));
    expect(await listed(DAYS(2))).toContain(soon.bookingId);
    // Still owed a decision: the session starting must not close the alert quietly.
    expect(await listed(DAYS(4))).toContain(soon.bookingId);
    expect(await listed(DAYS(15))).not.toContain(soon.bookingId);

    const later = await seed({ start: null });
    await recordWithdrawal(runner, input(later, { route: "desk", cardCountry: null }));
    expect(await listed(DAYS(14))).toContain(later.bookingId);
    expect(await listed(DAYS(15))).not.toContain(later.bookingId);
  });
});

describe("declineWithdrawal", () => {
  const desk = (s: Seeded) => input(s, { route: "desk", cardCountry: "AE" });

  it("records the desk's decline once, and the notice leaves the desk's list", async () => {
    const s = await seed({ start: "2026-12-10T15:00:00Z" });
    await recordWithdrawal(runner, desk(s));
    const now = new Date("2026-10-08T09:00:00Z");
    expect(await declineWithdrawal(runner, s.bookingId, now)).toBe("declined");
    expect(await declineWithdrawal(runner, s.bookingId, now)).toBe("already_declined");
    expect((await listWithdrawalsForDesk(runner, now)).map((w) => w.bookingId)).not.toContain(
      s.bookingId,
    );
    const found = await findBookingForWithdrawal(runner, s.reference, s.email);
    expect(found?.withdrawal?.declined).toBe(true);
    const booking = await db.query<{ status: string }>(
      `select status from bookings where id = $1`,
      [s.bookingId],
    );
    expect(booking.rows[0]?.status).toBe("confirmed");
  });

  it("refuses a notice refunded automatically, one already refunded, and a booking with none", async () => {
    const auto = await seed({ start: "2026-12-11T15:00:00Z" });
    await recordWithdrawal(runner, input(auto));
    expect(await declineWithdrawal(runner, auto.bookingId, new Date())).toBe("not_for_the_desk");

    const refunded = await seed({ start: "2026-12-12T15:00:00Z" });
    await recordWithdrawal(runner, desk(refunded));
    await db.query(
      `update orders set payment_status = 'refunded'
        where id = (select order_id from bookings where id = $1)`,
      [refunded.bookingId],
    );
    expect(await declineWithdrawal(runner, refunded.bookingId, new Date())).toBe(
      "not_for_the_desk",
    );

    const none = await seed({ start: "2026-12-13T15:00:00Z" });
    expect(await declineWithdrawal(runner, none.bookingId, new Date())).toBe("not_for_the_desk");
  });

  it("keeps a part-refunded notice on the desk's list: a gesture is not the decision", async () => {
    const s = await seed({ start: "2026-12-14T15:00:00Z" });
    await recordWithdrawal(runner, desk(s));
    await db.query(
      `update orders set payment_status = 'partially_refunded'
        where id = (select order_id from bookings where id = $1)`,
      [s.bookingId],
    );
    const now = new Date("2026-10-08T09:00:00Z");
    expect((await listWithdrawalsForDesk(runner, now)).map((w) => w.bookingId)).toContain(
      s.bookingId,
    );
  });
});
