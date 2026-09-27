import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { consentTexts, recordBookingConsent } from "./booking-consents";
import type { QueryRunner } from "./db";
import {
  AGREEMENT_TEXT,
  EXPRESS_REQUEST_TEXT,
  KEY_TERMS,
  TERMS_VERSION,
} from "@/config/booking-terms";

/**
 * The record a card dispute or a cancellation claim is answered with. Its
 * value is that it holds exactly the words shown, when, and from where.
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

async function newOrder(): Promise<string> {
  const customer = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Amina', 'Khan', $1, 'Asia/Dubai') returning id`,
    [`consent${++n}@example.com`],
  );
  const order = await db.query<{ id: string }>(
    `insert into orders (customer_id, order_type, session_slug, gross_amount_fils)
     values ($1, 'single', 'claude-claude-code', 149900) returning id`,
    [customer.rows[0]!.id],
  );
  return order.rows[0]!.id;
}

describe("recordBookingConsent", () => {
  it("stores the exact words shown, the version, when and from where", async () => {
    const orderId = await newOrder();
    const acceptedAt = new Date("2026-10-01T10:00:00Z");
    await recordBookingConsent(runner, {
      orderId,
      withinCancellationPeriod: true,
      expressRequest: true,
      acceptedAt,
      ipAddress: "203.0.113.7",
      userAgent: "Mozilla/5.0",
    });

    const row = (
      await db.query<Record<string, unknown>>(
        `select * from booking_consents where order_id = $1`,
        [orderId],
      )
    ).rows[0]!;
    expect(row.terms_version).toBe(TERMS_VERSION);
    expect(row.key_terms).toBe(KEY_TERMS.join("\n"));
    expect(row.agreement_text).toBe(AGREEMENT_TEXT);
    expect(row.express_request_text).toBe(EXPRESS_REQUEST_TEXT);
    expect(row.express_request).toBe(true);
    expect(new Date(row.accepted_at as string).toISOString()).toBe(acceptedAt.toISOString());
    expect(row.ip_address).toBe("203.0.113.7");
    expect(row.text_sha256).toBe(consentTexts(true).sha256);
  });

  it("stores no express request text when the box was not shown", async () => {
    const orderId = await newOrder();
    await recordBookingConsent(runner, {
      orderId,
      withinCancellationPeriod: false,
      expressRequest: false,
      acceptedAt: new Date(),
      ipAddress: null,
      userAgent: null,
    });
    const row = (
      await db.query<{ express_request_text: string | null }>(
        `select express_request_text from booking_consents where order_id = $1`,
        [orderId],
      )
    ).rows[0]!;
    expect(row.express_request_text).toBeNull();
  });

  // The database refuses it too; this proves the data layer never tries.
  it("cannot record a session inside the 14 days without the request", async () => {
    const orderId = await newOrder();
    await expect(
      recordBookingConsent(runner, {
        orderId,
        withinCancellationPeriod: true,
        expressRequest: false,
        acceptedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      }),
    ).rejects.toThrow(/booking_consents_express_when_needed/);
  });

  it("caps a long user agent rather than failing the booking", async () => {
    const orderId = await newOrder();
    await recordBookingConsent(runner, {
      orderId,
      withinCancellationPeriod: false,
      expressRequest: false,
      acceptedAt: new Date(),
      ipAddress: null,
      userAgent: "x".repeat(2000),
    });
    const row = (
      await db.query<{ user_agent: string }>(
        `select user_agent from booking_consents where order_id = $1`,
        [orderId],
      )
    ).rows[0]!;
    expect(row.user_agent).toHaveLength(500);
  });
});

describe("consentTexts", () => {
  it("seals a different hash when the words differ", () => {
    expect(consentTexts(true).sha256).not.toBe(consentTexts(false).sha256);
    expect(consentTexts(false).sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
