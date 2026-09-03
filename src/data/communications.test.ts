import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cancelQueuedCommunications,
  claimDueCommunications,
  countFailedCommunications,
  loadCommunicationContext,
  markCommunicationFailed,
  markCommunicationSent,
  queueForBooking,
  queueForOrder,
  requeueCommunication,
} from "./communications";
import type { QueryRunner } from "./db";

/**
 * The queue, against a real Postgres with the real migrations. The claim
 * query in particular - `for update skip locked` with a bounded batch - is
 * exactly the kind of SQL that reads right and behaves differently.
 */

const NOW = new Date("2026-10-01T09:00:00Z");
const LATER = new Date("2026-10-01T09:05:00Z");

let db: PGlite;
let runner: QueryRunner;

beforeAll(async () => {
  db = await PGlite.create();
  // PGlite's multi-statement entry point, applying the real migration files.
  const applySql = db.exec.bind(db);
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .toSorted()) {
    await applySql(readFileSync(join(dir, file), "utf8"));
  }
  runner = db as unknown as QueryRunner;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

let counter = 0;

/** A paid order with a scheduled booking - the state a customer is in once they have paid. */
async function scheduledBooking(options: { meetingUrl?: string | null; consent?: boolean } = {}) {
  counter += 1;
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone, marketing_consent, marketing_consent_at)
     values ('Amina', 'Khan', $1, 'Asia/Dubai', $2, $3) returning id`,
    [`queue${counter}@example.com`, options.consent ?? false, options.consent ? NOW : null],
  );
  const customerId = customer.rows[0]?.id ?? "";
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
     values ($1, 'single', 'claude-claude-code', 149900, 'paid') returning id`,
    [customerId],
  );
  const orderId = order.rows[0]?.id ?? "";
  // Three hours apart: sessions are ninety minutes and overlapping bookings are refused by the database.
  const start = new Date(NOW.getTime() + (counter * 3 + 24) * 60 * 60_000);
  const booking = await db.query<{ id: string }>(
    `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end, customer_timezone, meeting_url)
     values ($1, 'claude-claude-code', 1, 'scheduled', $2, $3, 'Asia/Dubai', $4) returning id`,
    [orderId, start, new Date(start.getTime() + 90 * 60_000), options.meetingUrl ?? null],
  );
  return { orderId, bookingId: booking.rows[0]?.id ?? "", customerId };
}

const rowsFor = async (bookingId: string) =>
  (
    await db.query<{
      template_key: string;
      status: string;
      attempts: number;
      scheduled_for: Date;
      last_error: string | null;
    }>(
      `select template_key, status, attempts, scheduled_for, last_error
         from communication_log where booking_id = $1 order by template_key`,
      [bookingId],
    )
  ).rows;

describe("queueForOrder", () => {
  it("queues each message for every booking on the order, once", async () => {
    const { orderId, bookingId } = await scheduledBooking();
    const messages = [
      { templateKey: "payment_receipt" as const, scheduledFor: NOW },
      { templateKey: "follow_up" as const, scheduledFor: LATER },
    ];

    expect(await queueForOrder(runner, orderId, messages)).toBe(2);
    expect(await queueForOrder(runner, orderId, messages)).toBe(0);

    expect(await rowsFor(bookingId)).toMatchObject([
      { template_key: "follow_up", status: "queued", attempts: 0, scheduled_for: LATER },
      { template_key: "payment_receipt", status: "queued", attempts: 0, scheduled_for: NOW },
    ]);
  });

  it("queues nothing for an order that has no bookings", async () => {
    const { customerId } = await scheduledBooking();
    const orphan = await db.query<{ id: string }>(
      `insert into orders (customer_id, order_type, session_slug, gross_amount_fils)
       values ($1, 'single', 'ai-agents', 169900) returning id`,
      [customerId],
    );
    expect(
      await queueForOrder(runner, orphan.rows[0]?.id ?? "", [
        { templateKey: "payment_receipt", scheduledFor: NOW },
      ]),
    ).toBe(0);
  });
});

describe("queueForBooking", () => {
  it("is idempotent per template", async () => {
    const { bookingId } = await scheduledBooking();
    const message = [{ templateKey: "reminder_24h" as const, scheduledFor: LATER }];
    expect(await queueForBooking(runner, bookingId, message)).toBe(1);
    expect(await queueForBooking(runner, bookingId, message)).toBe(0);
  });
});

describe("claimDueCommunications", () => {
  it("takes only queued rows whose time has come, and counts the attempt", async () => {
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [
      { templateKey: "payment_receipt", scheduledFor: NOW },
      { templateKey: "reminder_24h", scheduledFor: LATER },
    ]);

    const claimed = await claimDueCommunications(runner, NOW, 10);

    const mine = claimed.filter((c) => c.bookingId === bookingId);
    expect(mine).toEqual([
      { id: expect.any(String), bookingId, templateKey: "payment_receipt", attempts: 1 },
    ]);
    expect(await rowsFor(bookingId)).toMatchObject([
      { template_key: "payment_receipt", status: "queued", attempts: 1 },
      { template_key: "reminder_24h", status: "queued", attempts: 0 },
    ]);
  });

  it("does not hand the same row out twice while it is still queued and due", async () => {
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [{ templateKey: "follow_up", scheduledFor: NOW }]);
    const first = await claimDueCommunications(runner, NOW, 100);
    const [row] = first.filter((c) => c.bookingId === bookingId);
    expect(row).toBeDefined();
    await markCommunicationSent(runner, row?.id ?? "", "email_1", NOW);

    const second = await claimDueCommunications(runner, NOW, 100);

    expect(second.filter((c) => c.bookingId === bookingId)).toEqual([]);
  });

  it("respects the batch limit, earliest first", async () => {
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [
      { templateKey: "reminder_3h", scheduledFor: new Date(NOW.getTime() - 2 * 60_000) },
      { templateKey: "reminder_24h", scheduledFor: new Date(NOW.getTime() - 5 * 60_000) },
    ]);

    const claimed = await claimDueCommunications(runner, NOW, 1);

    expect(claimed.map((c) => c.templateKey)).toEqual(["reminder_24h"]);
  });
});

describe("loadCommunicationContext", () => {
  it("joins what a template and the send policy need, from the booking outward", async () => {
    const { bookingId } = await scheduledBooking({
      meetingUrl: "https://teams.example/join",
      consent: true,
    });

    const context = await loadCommunicationContext(runner, bookingId);

    expect(context).toMatchObject({
      bookingId,
      bookingStatus: "scheduled",
      sessionSlug: "claude-claude-code",
      meetingUrl: "https://teams.example/join",
      customerTimezone: "Asia/Dubai",
      firstName: "Amina",
      marketingConsent: true,
      unsubscribedAt: null,
    });
    expect(context?.email).toMatch(/^queue\d+@example\.com$/);
    expect(context?.scheduledStart).toBeInstanceOf(Date);
    expect(context?.scheduledEnd).toBeInstanceOf(Date);
  });

  it("is null for a booking that does not exist", async () => {
    expect(
      await loadCommunicationContext(runner, "00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
  });
});

describe("recording what happened", () => {
  it("marks sent with the provider's id, and clears the last error", async () => {
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [{ templateKey: "follow_up", scheduledFor: NOW }]);
    const [row] = (await claimDueCommunications(runner, NOW, 100)).filter(
      (c) => c.bookingId === bookingId,
    );
    await requeueCommunication(runner, row?.id ?? "", NOW, "rate_limit_exceeded");

    await markCommunicationSent(runner, row?.id ?? "", "email_abc", LATER);

    const [saved] = await db
      .query<{
        status: string;
        provider_message_id: string;
        sent_at: Date;
        last_error: string | null;
      }>(
        "select status, provider_message_id, sent_at, last_error from communication_log where id = $1",
        [row?.id],
      )
      .then((r) => r.rows);
    expect(saved).toEqual({
      status: "sent",
      provider_message_id: "email_abc",
      sent_at: LATER,
      last_error: null,
    });
  });

  it("marks failed with the reason, and counts it in the standing alarm", async () => {
    const before = await countFailedCommunications(runner);
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [{ templateKey: "follow_up", scheduledFor: NOW }]);
    const [row] = (await claimDueCommunications(runner, NOW, 100)).filter(
      (c) => c.bookingId === bookingId,
    );

    await markCommunicationFailed(runner, row?.id ?? "", "invalid_from_address", LATER);

    expect(await rowsFor(bookingId)).toMatchObject([
      { status: "failed", last_error: "invalid_from_address" },
    ]);
    expect(await countFailedCommunications(runner)).toBe(before + 1);
  });

  it("requeues for later, keeping the row queued so the next due run finds it", async () => {
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [{ templateKey: "follow_up", scheduledFor: NOW }]);
    const [row] = (await claimDueCommunications(runner, NOW, 100)).filter(
      (c) => c.bookingId === bookingId,
    );

    await requeueCommunication(runner, row?.id ?? "", LATER, "network");

    expect(await rowsFor(bookingId)).toMatchObject([
      { status: "queued", attempts: 1, scheduled_for: LATER, last_error: "network" },
    ]);
    expect(
      (await claimDueCommunications(runner, NOW, 100)).filter((c) => c.bookingId === bookingId),
    ).toEqual([]);
    expect(
      (await claimDueCommunications(runner, LATER, 100)).filter((c) => c.bookingId === bookingId),
    ).toHaveLength(1);
  });

  it("cancels everything still queued for a booking and leaves what was already sent alone", async () => {
    const { bookingId } = await scheduledBooking();
    await queueForBooking(runner, bookingId, [
      { templateKey: "booking_confirmation", scheduledFor: NOW },
      { templateKey: "reminder_24h", scheduledFor: LATER },
      { templateKey: "reminder_3h", scheduledFor: LATER },
    ]);
    const [sent] = (await claimDueCommunications(runner, NOW, 100)).filter(
      (c) => c.bookingId === bookingId,
    );
    await markCommunicationSent(runner, sent?.id ?? "", "email_1", NOW);

    expect(await cancelQueuedCommunications(runner, bookingId)).toBe(2);

    expect(await rowsFor(bookingId)).toMatchObject([
      { template_key: "booking_confirmation", status: "sent" },
      { template_key: "reminder_24h", status: "cancelled" },
      { template_key: "reminder_3h", status: "cancelled" },
    ]);
  });
});
