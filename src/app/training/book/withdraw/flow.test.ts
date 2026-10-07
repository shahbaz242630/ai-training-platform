import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryRunner } from "@/data/db";
import { bookingReference } from "@/domain/booking/withdrawal";
import { confirmWithdrawal, lookUpWithdrawal, type FlowDeps } from "./flow";

/**
 * The two steps a customer takes to withdraw, driven against a real
 * in-process Postgres with the real migrations.
 */

let db: PGlite;
let n = 0;
const DAY = 24 * 60 * 60 * 1000;
const context = { ipAddress: "203.0.113.9", userAgent: "test" };

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

const deps = (now: Date): FlowDeps => ({
  now,
  transaction: (work) => db.transaction((tx) => work(tx as unknown as QueryRunner)),
});

/** A paid booking made "now", for a session `startInDays` later. */
async function booked(startInDays: number | null = 20) {
  const email = `flow${++n}@example.com`;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Europe/London') returning id`,
    [email],
  );
  const order = await db.query<{ id: string; created_at: Date }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid') returning id, created_at`,
    [customer.rows[0]!.id],
  );
  const madeAt = order.rows[0]!.created_at;
  const start =
    startInDays === null
      ? null
      : new Date(madeAt.getTime() + startInDays * DAY + n * 3_600_000 * 3);
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start,
                           scheduled_end, customer_timezone)
     values ($1, 'claude-claude-code', 1, $2, $3, $4, 'Europe/London') returning id`,
    [
      order.rows[0]!.id,
      start === null ? "awaiting_schedule" : "confirmed",
      start,
      start === null ? null : new Date(start.getTime() + 90 * 60_000),
    ],
  );
  const bookingId = booking.rows[0]!.id;
  return {
    bookingId,
    madeAt,
    start,
    form: {
      fullName: "Amina Khan",
      email,
      reference: bookingReference(bookingId).toLowerCase(),
      consumer: true,
    },
  };
}

describe("step 1: look up", () => {
  it("shows the booking, the full refund and the statement to confirm", async () => {
    const b = await booked();
    const result = await lookUpWithdrawal(b.form, deps(new Date(b.madeAt.getTime() + DAY)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toMatchObject({
      reference: bookingReference(b.bookingId),
      sessionTitle: "Claude, Claude Code & Advanced Workflows",
      amountPaid: "AED 1,499",
      refundDue: "AED 1,499",
    });
    expect(result.summary.statement).toContain("I, Amina Khan, withdraw from my contract");
    expect(result.summary.sessionTime).toContain("(Europe/London)");
    expect(result.alreadyReceived).toBeNull();
  });

  it("writes nothing", async () => {
    const b = await booked();
    await lookUpWithdrawal(b.form, deps(new Date(b.madeAt.getTime() + DAY)));
    const rows = await db.query(`select 1 from withdrawal_requests where booking_id = $1`, [
      b.bookingId,
    ]);
    expect(rows.rows).toHaveLength(0);
  });

  it("refuses without the consumer declaration", async () => {
    const b = await booked();
    const result = await lookUpWithdrawal({ ...b.form, consumer: false }, deps(new Date()));
    expect(result).toEqual({
      ok: false,
      message: "Please confirm you live in the UK or EU and booked for yourself.",
    });
  });

  it("gives the same answer for a wrong email and a wrong reference", async () => {
    const b = await booked();
    const now = deps(new Date(b.madeAt.getTime() + DAY));
    const wrongEmail = await lookUpWithdrawal({ ...b.form, email: "x@example.com" }, now);
    const wrongRef = await lookUpWithdrawal({ ...b.form, reference: "00000000" }, now);
    expect(wrongEmail.ok).toBe(false);
    expect(wrongEmail).toEqual(wrongRef);
  });

  it("explains a reference that cannot be one", async () => {
    const b = await booked();
    const result = await lookUpWithdrawal({ ...b.form, reference: "abc" }, deps(new Date()));
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/8 letters/) });
  });

  it("refuses after 14 days, naming where to write", async () => {
    const b = await booked(40);
    const result = await lookUpWithdrawal(b.form, deps(new Date(b.madeAt.getTime() + 15 * DAY)));
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/14 days/) });
    expect(result.ok ? "" : result.message).toContain("knowledgecentre@zaaheen.com");
  });

  it("refuses once the session has started", async () => {
    const b = await booked(2);
    const result = await lookUpWithdrawal(b.form, deps(new Date(b.start!.getTime() + 3_600_000)));
    expect(result).toMatchObject({ ok: false, message: expect.stringMatching(/already started/) });
  });

  it("shows a booking still waiting for a time", async () => {
    const b = await booked(null);
    const result = await lookUpWithdrawal(b.form, deps(new Date(b.madeAt.getTime() + DAY)));
    expect(result.ok && result.summary.sessionTime).toBeNull();
  });
});

describe("step 2: confirm", () => {
  it("keeps the notice and returns when it was received and the refund", async () => {
    const b = await booked();
    const now = new Date(b.madeAt.getTime() + DAY);
    const result = await confirmWithdrawal(b.form, deps(now), context);
    expect(result).toMatchObject({
      ok: true,
      bookingId: b.bookingId,
      receipt: { refundDue: "AED 1,499", isNew: true },
    });
    const kept = await db.query<{ statement: string; ip_address: string }>(
      `select statement, ip_address from withdrawal_requests where booking_id = $1`,
      [b.bookingId],
    );
    expect(kept.rows[0]?.statement).toContain("I, Amina Khan, withdraw");
    expect(kept.rows[0]?.ip_address).toBe("203.0.113.9");
  });

  it("decides again at confirmation: a session that started meanwhile is refused", async () => {
    const b = await booked(2);
    const result = await confirmWithdrawal(
      b.form,
      deps(new Date(b.start!.getTime() + 3_600_000)),
      context,
    );
    expect(result.ok).toBe(false);
    const rows = await db.query(`select 1 from withdrawal_requests where booking_id = $1`, [
      b.bookingId,
    ]);
    expect(rows.rows).toHaveLength(0);
  });

  it("answers a second confirmation with the first notice, not a new one", async () => {
    const b = await booked();
    const first = await confirmWithdrawal(
      b.form,
      deps(new Date(b.madeAt.getTime() + DAY)),
      context,
    );
    const second = await confirmWithdrawal(
      b.form,
      deps(new Date(b.madeAt.getTime() + 2 * DAY)),
      context,
    );
    expect(second).toMatchObject({ ok: true, receipt: { isNew: false } });
    expect(first.ok && second.ok && second.receipt.received).toBe(
      first.ok && first.receipt.received,
    );
  });

  it("after confirming, step 1 says the notice was already received", async () => {
    const b = await booked();
    const now = deps(new Date(b.madeAt.getTime() + DAY));
    await confirmWithdrawal(b.form, now, context);
    const again = await lookUpWithdrawal(b.form, now);
    expect(again).toMatchObject({ ok: true, alreadyReceived: { isNew: false } });
  });
});
