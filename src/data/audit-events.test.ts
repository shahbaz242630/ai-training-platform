import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { countPaidButUnscheduled, insertAuditEvent } from "./audit-events";
import type { QueryRunner } from "./db";
import type { AuditEvent } from "@/lib/audit";

/**
 * Evidence of what happened to somebody money and booking.
 *
 * This trail used to be written to the host stdout, which is not evidence: it
 * rotates, it cannot be queried, and nobody owns it. Two properties are worth
 * more than the rest here - that it persists at all, and that it cannot be
 * quietly edited afterwards.
 *
 * (The migration loader uses the PGlite multi-statement SQL entry point - a
 * SQL executor, unrelated to child_process despite the name an editor security
 * reminder matches on.)
 */

let db: PGlite;
let runner: QueryRunner;

beforeAll(async () => {
  db = await PGlite.create();
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  runner = db as unknown as QueryRunner;
}, 120_000);

afterAll(async () => {
  await db?.close();
});

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  action: "order.payment_succeeded",
  actor: { kind: "provider", provider: "stripe" },
  subject: "order:" + randomUUID(),
  occurredAt: "2027-12-01T10:00:00.000Z",
  ...overrides,
});

describe("insertAuditEvent", () => {
  it("persists an event that can be read back", async () => {
    const e = event({ metadata: { eventId: "evt_1" } });
    await insertAuditEvent(runner, e);

    const row = await db
      .query<{ action: string; actor_kind: string; actor_id: string; metadata: unknown }>(
        "select action, actor_kind, actor_id, metadata from audit_events where subject = $1",
        [e.subject],
      )
      .then((r) => r.rows[0]);

    expect(row?.action).toBe("order.payment_succeeded");
    expect(row?.actor_kind).toBe("provider");
    expect(row?.actor_id).toBe("stripe");
    expect(row?.metadata).toEqual({ eventId: "evt_1" });
  });

  it("records each kind of actor with its own identifier", async () => {
    const cases: AuditEvent["actor"][] = [
      { kind: "customer", customerId: "cust-1" },
      { kind: "admin", adminId: "admin-1" },
      { kind: "system", process: "sweep-holds" },
      { kind: "provider", provider: "stripe" },
    ];

    for (const actor of cases) {
      const e = event({ actor });
      await insertAuditEvent(runner, e);
      const row = await db
        .query<{ actor_kind: string; actor_id: string }>(
          "select actor_kind, actor_id from audit_events where subject = $1",
          [e.subject],
        )
        .then((r) => r.rows[0]);
      expect(row?.actor_kind).toBe(actor.kind);
      expect(row?.actor_id).toBeTruthy();
    }
  });

  it("keeps when it happened apart from when it was written", async () => {
    const e = event();
    await insertAuditEvent(runner, e);

    const row = await db
      .query<{ occurred_at: Date; recorded_at: Date }>(
        "select occurred_at, recorded_at from audit_events where subject = $1",
        [e.subject],
      )
      .then((r) => r.rows[0]);

    expect(row?.occurred_at.toISOString()).toBe("2027-12-01T10:00:00.000Z");
    expect(row?.recorded_at).toBeInstanceOf(Date);
  });

  it("accepts an event carrying no metadata", async () => {
    const e = event();
    await expect(insertAuditEvent(runner, e)).resolves.toBeUndefined();
  });
});

/*
  Append-only, ATTEMPTED rather than asserted from a comment.

  `audit.ts` has described this trail as append-only since Phase 0. A comment
  does not make it so - a row that can be edited is not evidence, because the
  first thing anybody covering a mistake would do is edit it.
*/
describe("the audit trail is append-only", () => {
  it("refuses an update", async () => {
    const e = event();
    await insertAuditEvent(runner, e);

    await expect(
      db.query("update audit_events set action = 'tampered' where subject = $1", [e.subject]),
    ).rejects.toThrow(/append-only/i);
  });

  it("refuses a delete", async () => {
    const e = event();
    await insertAuditEvent(runner, e);

    await expect(
      db.query("delete from audit_events where subject = $1", [e.subject]),
    ).rejects.toThrow(/append-only/i);
  });

  it("leaves the row exactly as written after a refused tamper", async () => {
    const e = event({ action: "order.payment_succeeded" });
    await insertAuditEvent(runner, e);
    await db
      .query("update audit_events set action = 'tampered' where subject = $1", [e.subject])
      .catch(() => undefined);

    const row = await db
      .query<{ action: string }>("select action from audit_events where subject = $1", [e.subject])
      .then((r) => r.rows[0]);
    expect(row?.action).toBe("order.payment_succeeded");
  });
});

/*
  The standing alarm for the one state that needs a human: money taken, no
  session booked.
*/
describe("countPaidButUnscheduled", () => {
  const makeOrder = async (paymentStatus: string, bookingStatus: string) => {
    const customer = await db.query<{ id: string }>(
      `insert into customers (first_name, last_name, email, timezone)
       values ('A', 'K', $1, 'Asia/Dubai') returning id`,
      [`${randomUUID()}@example.com`],
    );
    const order = await db.query<{ id: string }>(
      `insert into orders (customer_id, order_type, session_slug, gross_amount_fils, payment_status)
       values ($1, 'single', 'ai-foundations', 129900, $2) returning id`,
      [customer.rows[0]?.id, paymentStatus],
    );
    const orderId = order.rows[0]?.id;
    await db.query(
      `insert into bookings (order_id, session_slug, sequence, status, scheduled_start, scheduled_end, customer_timezone)
       values ($1, 'ai-foundations', 1, $2, $3, $4, 'Asia/Dubai')`,
      [orderId, bookingStatus, new Date("2028-01-10T10:00:00Z"), new Date("2028-01-10T11:30:00Z")],
    );
    return orderId;
  };

  it("counts nothing when every paid order is scheduled", async () => {
    await makeOrder("paid", "scheduled");
    expect(await countPaidButUnscheduled(runner)).toBe(0);
  });

  /* THE one. Money taken, customer in no calendar. */
  it("counts a paid order whose booking is still waiting", async () => {
    await makeOrder("paid", "awaiting_schedule");
    expect(await countPaidButUnscheduled(runner)).toBe(1);
  });

  /*
    An unpaid order waiting to be scheduled is the NORMAL state between
    starting checkout and paying. Counting it would make the alarm fire
    constantly and be ignored, which is the same as having no alarm.
  */
  it("ignores a pending order that is waiting, because that is normal", async () => {
    // Measured either side rather than against a fixed number, so the
    // assertion says what it means - this order must not move the count - and
    // does not silently depend on what earlier tests left behind.
    const before = await countPaidButUnscheduled(runner);
    await makeOrder("pending", "awaiting_schedule");
    expect(await countPaidButUnscheduled(runner)).toBe(before);
  });

  it("ignores a failed order that never got scheduled", async () => {
    const before = await countPaidButUnscheduled(runner);
    await makeOrder("failed", "awaiting_schedule");
    expect(await countPaidButUnscheduled(runner)).toBe(before);
  });
});

/*
  TRUNCATE is a separate trigger event. The row-level trigger that refuses
  UPDATE and DELETE does not fire on it at all, so the table could be emptied
  in one statement while every other protection looked intact.
*/
describe("append-only survives TRUNCATE", () => {
  it("refuses to truncate the audit trail", async () => {
    await insertAuditEvent(runner, event());
    await expect(db.query("truncate audit_events")).rejects.toThrow(/append-only/i);
  });

  it("leaves the rows in place after a refused truncate", async () => {
    const e = event();
    await insertAuditEvent(runner, e);
    await db.query("truncate audit_events").catch(() => undefined);

    const remaining = await db
      .query<{ n: number }>("select count(*)::int as n from audit_events where subject = $1", [
        e.subject,
      ])
      .then((r) => r.rows[0]?.n);
    expect(remaining).toBe(1);
  });
});
