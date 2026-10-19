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

/** Every payment asked about, so a test can see whether the processor was asked at all. */
let asked: string[] = [];

const deps = (
  now: Date,
  cardCountry: (paymentIntentId: string) => Promise<string | null> = () => Promise.resolve("GB"),
): FlowDeps => ({
  now,
  transaction: (work) => db.transaction((tx) => work(tx as unknown as QueryRunner)),
  cardCountry: (paymentIntentId) => {
    asked.push(paymentIntentId);
    return cardCountry(paymentIntentId);
  },
});

/** A paid booking made "now", for a session `startInDays` later. */
async function booked(startInDays: number | null = 20, paid: { intent?: string | null } = {}) {
  const email = `flow${++n}@example.com`;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Europe/London') returning id`,
    [email],
  );
  const order = await db.query<{ id: string; created_at: Date }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status,
                         stripe_payment_intent_id)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid', $2) returning id, created_at`,
    [customer.rows[0]!.id, paid.intent === undefined ? `pi_flow_${n}` : paid.intent],
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
      message:
        "This form is for the 14-day cancellation right that UK and EU consumers have. Living elsewhere? You can move your session once, free, from the Reschedule link in your booking email, or email knowledgecentre@zaaheen.com.",
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
    const result = await lookUpWithdrawal(b.form, deps(new Date(b.madeAt.getTime() + 16 * DAY)));
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

describe("step 2: who decides the refund", () => {
  const status = async (bookingId: string) =>
    (await db.query<{ status: string }>(`select status from bookings where id = $1`, [bookingId]))
      .rows[0]?.status;
  const kept = async (bookingId: string) =>
    (
      await db.query<{ route: string; card_country: string | null }>(
        `select route, card_country from withdrawal_requests where booking_id = $1`,
        [bookingId],
      )
    ).rows[0];

  // A card says where it was issued, not where its holder lives: Dubai is full of UK cards.
  it("sends a UK card to the desk too: nothing is refunded on a card alone", async () => {
    const b = await booked();
    const result = await confirmWithdrawal(
      b.form,
      deps(new Date(b.madeAt.getTime() + DAY), () => Promise.resolve("GB")),
      context,
    );
    expect(result).toMatchObject({ ok: true, receipt: { route: "desk", isNew: true } });
    expect(await status(b.bookingId)).toBe("confirmed");
    expect(await kept(b.bookingId)).toEqual({ route: "desk", card_country: "GB" });
    const refunds = await db.query(
      `select 1 from refunds r join withdrawal_requests w on w.id = r.withdrawal_request_id
        where w.booking_id = $1`,
      [b.bookingId],
    );
    expect(refunds.rows).toHaveLength(0);
  });

  it("sends a UAE card to the desk, whatever box was ticked: the booking stays", async () => {
    const b = await booked();
    const result = await confirmWithdrawal(
      b.form,
      deps(new Date(b.madeAt.getTime() + DAY), () => Promise.resolve("AE")),
      context,
    );
    expect(result).toMatchObject({ ok: true, receipt: { route: "desk", isNew: true } });
    expect(await status(b.bookingId)).toBe("confirmed");
    expect(await kept(b.bookingId)).toEqual({ route: "desk", card_country: "AE" });
  });

  it("sends the desk a notice whose card country could not be read", async () => {
    const b = await booked();
    const result = await confirmWithdrawal(
      b.form,
      deps(new Date(b.madeAt.getTime() + DAY), () => Promise.reject(new Error("timed out"))),
      context,
    );
    expect(result).toMatchObject({ ok: true, receipt: { route: "desk" } });
    expect(await status(b.bookingId)).toBe("confirmed");
    expect(await kept(b.bookingId)).toEqual({ route: "desk", card_country: null });
  });

  it("sends the desk a payment the processor has no record of, without asking", async () => {
    const b = await booked(20, { intent: null });
    asked = [];
    const result = await confirmWithdrawal(
      b.form,
      deps(new Date(b.madeAt.getTime() + DAY)),
      context,
    );
    expect(result).toMatchObject({ ok: true, receipt: { route: "desk" } });
    expect(asked).toEqual([]);
  });

  it("asks once, and a second confirmation keeps the first route", async () => {
    const b = await booked();
    const now = new Date(b.madeAt.getTime() + DAY);
    asked = [];
    await confirmWithdrawal(
      b.form,
      deps(now, () => Promise.resolve("AE")),
      context,
    );
    const again = await confirmWithdrawal(
      b.form,
      deps(now, () => Promise.resolve("GB")),
      context,
    );
    expect(again).toMatchObject({ ok: true, receipt: { route: "desk", isNew: false } });
    expect(asked).toHaveLength(1);
    expect(await status(b.bookingId)).toBe("confirmed");
  });

  it("does not ask about a booking it is about to refuse", async () => {
    const b = await booked(2);
    asked = [];
    await confirmWithdrawal(b.form, deps(new Date(b.start!.getTime() + 3_600_000)), context);
    expect(asked).toEqual([]);
  });
});

describe("a later look at a notice the desk decides", () => {
  const confirmDesk = async () => {
    const b = await booked();
    const now = new Date(b.madeAt.getTime() + DAY);
    await confirmWithdrawal(
      b.form,
      deps(now, () => Promise.resolve("AE")),
      context,
    );
    return { b, now };
  };

  it("says it is being reviewed while it waits", async () => {
    const { b, now } = await confirmDesk();
    expect(await lookUpWithdrawal(b.form, deps(now))).toMatchObject({
      ok: true,
      alreadyReceived: { route: "desk", deskState: "reviewing" },
    });
  });

  it("says it was declined once the desk declined it", async () => {
    const { b, now } = await confirmDesk();
    await db.query(
      `insert into withdrawal_decisions (booking_id, decision, decided_at) values ($1, 'declined', $2)`,
      [b.bookingId, now],
    );
    expect(await lookUpWithdrawal(b.form, deps(now))).toMatchObject({
      ok: true,
      alreadyReceived: { deskState: "declined" },
    });
  });

  it("says it was refunded once the desk approved it", async () => {
    const { b, now } = await confirmDesk();
    await db.query(
      `update orders set payment_status = 'refunded'
        where id = (select order_id from bookings where id = $1)`,
      [b.bookingId],
    );
    expect(await lookUpWithdrawal(b.form, deps(now))).toMatchObject({
      ok: true,
      alreadyReceived: { deskState: "refunded" },
    });
  });

  it("does not say the booking is cancelled when a refund left it in place", async () => {
    const { b, now } = await confirmDesk();
    await db.query(
      `update orders set payment_status = 'refunded'
        where id = (select order_id from bookings where id = $1)`,
      [b.bookingId],
    );
    expect(await lookUpWithdrawal(b.form, deps(now))).toMatchObject({
      ok: true,
      alreadyReceived: { deskState: "refunded", bookingCancelled: false },
    });
  });

  it("says reviewing for every new notice, whatever the card", async () => {
    const b = await booked();
    const now = new Date(b.madeAt.getTime() + DAY);
    const result = await confirmWithdrawal(b.form, deps(now), context);
    expect(result).toMatchObject({ ok: true, receipt: { route: "desk", deskState: "reviewing" } });
  });
});
