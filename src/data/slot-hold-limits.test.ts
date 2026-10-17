import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { holdSlot, type HoldLimits } from "./slot-holds";
import type { QueryRunner } from "./db";

/*
  THE DIARY-HOLDING ATTACK (security audit, 2026-09-27).

  A hold costs its holder nothing, and before these limits nothing counted how
  many one person had: a script that entered its details once could start a
  checkout for every offered time and keep the whole calendar held without
  paying, filling the real diary with tentative events as it went. Each case
  below is that attack, or one of the ways round a limit, against a real
  Postgres with the real migrations.
*/

let db: PGlite;
let realTransaction: <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;

beforeAll(async () => {
  db = await PGlite.create();
  const dir = join(process.cwd(), "supabase", "migrations");
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".sql"))
    .toSorted()) {
    await db.exec(readFileSync(join(dir, f), "utf8"));
  }
  realTransaction = async (work) => {
    await db.query("begin");
    try {
      const result = await work(db as unknown as QueryRunner);
      await db.query("commit");
      return result;
    } catch (error) {
      await db.query("rollback");
      throw error;
    }
  };
}, 120_000);

afterAll(async () => {
  await db?.close();
});

// Every test starts from an empty diary, so the diary-wide count sees only its own holds.
beforeEach(async () => {
  await db.query("delete from slot_holds");
});

const NOW = new Date("2031-01-01T00:00:00Z");
const LIMITS: HoldLimits = { maxPerAddress: 3, maxLive: 10, now: NOW };
let emailCounter = 0;

const newCustomer = async (): Promise<string> => {
  emailCounter += 1;
  const r = await db.query<{ id: string }>(
    `insert into customers (first_name, last_name, email, timezone)
     values ('Test', 'Person', $1, 'Asia/Dubai') returning id`,
    [`limits-${emailCounter}@example.invalid`],
  );
  const id = r.rows[0]?.id;
  if (!id) throw new Error("could not create a test customer");
  return id;
};

/** One browser: a customer as the email names them, plus the key only that browser's cookie holds. */
const ownerFor = (customerId: string, clientAddress: string | null) => ({
  customerId,
  ownerKey: randomUUID(),
  clientAddress,
});

// Hour-long slots, two hours apart, so no two ever overlap.
const slotAt = (index: number) => {
  const start = new Date(Date.UTC(2031, 1, 1) + index * 2 * 60 * 60_000);
  return {
    slotStart: start,
    slotEnd: new Date(start.getTime() + 60 * 60_000),
    expiresAt: new Date(NOW.getTime() + 35 * 60_000),
  };
};

const statusOf = async (id: string) =>
  (await db.query<{ status: string }>(`select status from slot_holds where id = $1`, [id])).rows[0]
    ?.status;

const liveHoldsFor = async (customerId: string) =>
  (
    await db.query<{ n: number }>(
      `select count(*)::int as n from slot_holds where customer_id = $1 and status = 'held'`,
      [customerId],
    )
  ).rows[0]?.n;

describe("holdSlot with an owner and limits", () => {
  it("keeps one live hold per browser: a new hold releases its earlier one", async () => {
    const customerId = await newCustomer();
    const owner = ownerFor(customerId, "198.51.100.1");

    const first = await holdSlot({ ...slotAt(0), owner, limits: LIMITS }, realTransaction);
    const second = await holdSlot({ ...slotAt(1), owner, limits: LIMITS }, realTransaction);

    if (!first.ok || !second.ok) throw new Error("both holds should have been taken");
    expect(second.released.map((r) => r.id)).toEqual([first.hold.id]);
    expect(await statusOf(first.hold.id)).toBe("released");
    expect(await liveHoldsFor(customerId)).toBe(1);
  });

  it("stops one visitor holding the diary: twenty tries end with one hold", async () => {
    const customerId = await newCustomer();
    const owner = ownerFor(customerId, "198.51.100.2");

    for (let i = 0; i < 20; i++) {
      const outcome = await holdSlot({ ...slotAt(i), owner, limits: LIMITS }, realTransaction);
      expect(outcome.ok).toBe(true);
    }

    expect(await liveHoldsFor(customerId)).toBe(1);
  });

  it("lets a person pick the same time again after changing their mind", async () => {
    const owner = ownerFor(await newCustomer(), "198.51.100.3");

    await holdSlot({ ...slotAt(0), owner, limits: LIMITS }, realTransaction);
    const again = await holdSlot({ ...slotAt(0), owner, limits: LIMITS }, realTransaction);

    // Their own earlier hold is released first, so it cannot block them.
    expect(again.ok).toBe(true);
  });

  it("keeps a person's hold when the new one loses its race", async () => {
    const owner = ownerFor(await newCustomer(), "198.51.100.4");
    const other = ownerFor(await newCustomer(), "198.51.100.5");

    const mine = await holdSlot({ ...slotAt(0), owner, limits: LIMITS }, realTransaction);
    await holdSlot({ ...slotAt(1), owner: other, limits: LIMITS }, realTransaction);
    const lost = await holdSlot({ ...slotAt(1), owner, limits: LIMITS }, realTransaction);

    expect(lost).toEqual({ ok: false, reason: "slot_taken" });
    // The release rolled back with the failed insert: they still have their time.
    if (!mine.ok) throw new Error("setup");
    expect(await statusOf(mine.hold.id)).toBe("held");
  });

  it("never releases a person's paid-for (converted) hold", async () => {
    const owner = ownerFor(await newCustomer(), "198.51.100.6");

    const paid = await holdSlot({ ...slotAt(0), owner, limits: LIMITS }, realTransaction);
    if (!paid.ok) throw new Error("setup");
    await db.query(`update slot_holds set status = 'converted' where id = $1`, [paid.hold.id]);
    const next = await holdSlot({ ...slotAt(1), owner, limits: LIMITS }, realTransaction);

    if (!next.ok) throw new Error("the second hold should have been taken");
    expect(next.released).toEqual([]);
    expect(await statusOf(paid.hold.id)).toBe("converted");
  });

  it("refuses a fourth live hold from one connection, even as different people", async () => {
    const clientAddress = "198.51.100.7";

    for (let i = 0; i < 3; i++) {
      const owner = ownerFor(await newCustomer(), clientAddress);
      expect((await holdSlot({ ...slotAt(i), owner, limits: LIMITS }, realTransaction)).ok).toBe(
        true,
      );
    }
    const owner = ownerFor(await newCustomer(), clientAddress);
    const fourth = await holdSlot({ ...slotAt(3), owner, limits: LIMITS }, realTransaction);

    expect(fourth).toEqual({ ok: false, reason: "address_limit" });
  });

  it("refuses new holds once the diary-wide cap of live holds is reached", async () => {
    for (let i = 0; i < 10; i++) {
      const owner = ownerFor(await newCustomer(), `203.0.113.${i + 1}`);
      expect((await holdSlot({ ...slotAt(i), owner, limits: LIMITS }, realTransaction)).ok).toBe(
        true,
      );
    }
    const owner = ownerFor(await newCustomer(), "203.0.113.99");
    const eleventh = await holdSlot({ ...slotAt(10), owner, limits: LIMITS }, realTransaction);

    expect(eleventh).toEqual({ ok: false, reason: "diary_busy" });
  });

  it("still applies the diary-wide cap when the caller's address is unknown", async () => {
    for (let i = 0; i < 10; i++) {
      const owner = ownerFor(await newCustomer(), null);
      await holdSlot({ ...slotAt(i), owner, limits: LIMITS }, realTransaction);
    }
    const owner = ownerFor(await newCustomer(), null);
    const next = await holdSlot({ ...slotAt(10), owner, limits: LIMITS }, realTransaction);

    expect(next).toEqual({ ok: false, reason: "diary_busy" });
  });

  it("does not count holds whose time has run out, swept or not", async () => {
    const clientAddress = "198.51.100.8";

    for (let i = 0; i < 3; i++) {
      const owner = ownerFor(await newCustomer(), clientAddress);
      await holdSlot(
        { ...slotAt(i), expiresAt: new Date(NOW.getTime() - 60_000), owner, limits: LIMITS },
        realTransaction,
      );
    }
    const owner = ownerFor(await newCustomer(), clientAddress);
    const next = await holdSlot({ ...slotAt(3), owner, limits: LIMITS }, realTransaction);

    expect(next.ok).toBe(true);
  });

  it("records whose hold it is", async () => {
    const owner = ownerFor(await newCustomer(), "198.51.100.9");

    const outcome = await holdSlot({ ...slotAt(0), owner, limits: LIMITS }, realTransaction);
    if (!outcome.ok) throw new Error("setup");

    const row = await db.query<{ customer_id: string; owner_key: string; client_address: string }>(
      `select customer_id, owner_key, client_address from slot_holds where id = $1`,
      [outcome.hold.id],
    );
    expect(row.rows[0]).toEqual({
      customer_id: owner.customerId,
      owner_key: owner.ownerKey,
      client_address: "198.51.100.9",
    });
  });

  // Holds taken before the owner key existed have none: they are never given
  // back early, only expire, which is the safe side.
  it("never releases a hold that has no owner key", async () => {
    const owner = ownerFor(await newCustomer(), "198.51.100.10");
    const old = await holdSlot({ ...slotAt(0), owner, limits: LIMITS }, realTransaction);
    if (!old.ok) throw new Error("setup");
    await db.query(`update slot_holds set owner_key = null where id = $1`, [old.hold.id]);

    const next = await holdSlot({ ...slotAt(1), owner, limits: LIMITS }, realTransaction);

    if (!next.ok) throw new Error("the second hold should have been taken");
    expect(next.released).toEqual([]);
    expect(await statusOf(old.hold.id)).toBe("held");
  });

  it("leaves a hold with no owner exactly as before", async () => {
    const outcome = await holdSlot(slotAt(0), realTransaction);

    if (!outcome.ok) throw new Error("an ownerless hold should still be taken");
    expect(outcome.released).toEqual([]);
  });
});

/*
  THE CHECKOUT-HIJACK ATTACK (security audit, 2026-10-17).

  A customer is matched on the email they type, and typing an email proves
  nothing. "One live hold per person" used to release every live hold of that
  customer, so a stranger who knew somebody's email could enter it, start a
  checkout, and release the hold behind the checkout that person was paying
  for at that moment - ending their payment and taking their time, for free,
  as often as they liked. A hold is now given back only by the browser that
  took it: the same customer AND the owner key in that browser's cookie.
*/
describe("a stranger who knows a customer's email", () => {
  it("cannot release that customer's hold", async () => {
    const customerId = await newCustomer();
    const victim = ownerFor(customerId, "198.51.100.20");
    const stranger = ownerFor(customerId, "198.51.100.21");

    const paying = await holdSlot({ ...slotAt(0), owner: victim, limits: LIMITS }, realTransaction);
    const theirs = await holdSlot(
      { ...slotAt(1), owner: stranger, limits: LIMITS },
      realTransaction,
    );

    if (!paying.ok || !theirs.ok) throw new Error("both holds should have been taken");
    expect(theirs.released).toEqual([]);
    expect(await statusOf(paying.hold.id)).toBe("held");
  });

  it("cannot take the time that customer is paying for", async () => {
    const customerId = await newCustomer();
    const victim = ownerFor(customerId, "198.51.100.22");
    const stranger = ownerFor(customerId, "198.51.100.23");

    const paying = await holdSlot({ ...slotAt(0), owner: victim, limits: LIMITS }, realTransaction);
    const snipe = await holdSlot(
      { ...slotAt(0), owner: stranger, limits: LIMITS },
      realTransaction,
    );

    expect(snipe).toEqual({ ok: false, reason: "slot_taken" });
    if (!paying.ok) throw new Error("setup");
    expect(await statusOf(paying.hold.id)).toBe("held");
  });

  it("does not hand back that customer's checkout to be ended", async () => {
    const customerId = await newCustomer();
    const victim = ownerFor(customerId, "198.51.100.24");
    const stranger = ownerFor(customerId, "198.51.100.25");

    await holdSlot({ ...slotAt(0), owner: victim, limits: LIMITS }, realTransaction);
    await holdSlot({ ...slotAt(1), owner: stranger, limits: LIMITS }, realTransaction);
    const again = await holdSlot(
      { ...slotAt(2), owner: stranger, limits: LIMITS },
      realTransaction,
    );

    // The stranger's own earlier hold is theirs to give back; the victim's is not.
    if (!again.ok) throw new Error("setup");
    expect(again.released).toHaveLength(1);
    expect(await liveHoldsFor(customerId)).toBe(2);
  });
});
