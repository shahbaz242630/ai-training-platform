import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { QueryRunner } from "@/data/db";
import { recordFraudWarning } from "@/data/fraud-warnings";
import { MockEmailProvider } from "@/domain/messaging/mock-provider";
import { fraudWarningAlerts } from "./fraud-warning-step";

/**
 * Early fraud warnings told to the desk (audit s104 PAY-4): one email per
 * warning, once a day while one waits for a person, closed when it is
 * refunded or old, and a failure reported rather than thrown.
 */

let db: PGlite;
let mail: MockEmailProvider;
const NOW = new Date("2027-03-01T12:00:00Z");
const DESK = "desk@example.com";
let n = 0;

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

beforeEach(async () => {
  await db.query(`delete from desk_alerts`);
  await db.query(`delete from fraud_warnings`);
  mail = new MockEmailProvider();
});

const tx = <T>(work: (r: QueryRunner) => Promise<T>) =>
  db.transaction((t) => work(t as unknown as QueryRunner));

const run = (now: Date) =>
  fraudWarningAlerts({ transaction: tx, email: () => mail, clock: () => now, desk: () => DESK });

async function warn(intent: string, at: Date): Promise<void> {
  n += 1;
  await tx((r) =>
    recordFraudWarning(
      r,
      {
        kind: "fraud_warning",
        eventId: `evt_step_${n}`,
        type: "radar.early_fraud_warning.created",
        occurredAt: at,
        ignorable: false,
        providerWarningId: `issfr_step_${n}`,
        paymentIntentId: intent,
        fraudType: "made_with_stolen_card",
        actionable: true,
      },
      at,
    ),
  );
}

describe("the fraud warning step", () => {
  it("emails the desk once per warning, and not again within the day", async () => {
    await warn("pi_unknown_1", NOW);
    expect(await run(NOW)).toMatchObject({ raised: 1, open: 1 });
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.to).toBe(DESK);
    expect(mail.sent[0]?.subject).toMatch(/^Stolen card warning, needs you: /);
    expect(await run(new Date(NOW.getTime() + 5 * 60_000))).toMatchObject({ raised: 0 });
    expect(mail.sent).toHaveLength(1);
  });

  it("closes a warning once it is too old to act on", async () => {
    await warn("pi_unknown_2", NOW);
    await run(NOW);
    expect(await run(new Date(NOW.getTime() + 15 * 24 * 60 * 60_000))).toMatchObject({
      resolved: 1,
      open: 0,
    });
  });

  it("reports a failure instead of throwing, so the sweep goes on", async () => {
    const report = await fraudWarningAlerts({
      transaction: () => Promise.reject(new Error("database down")),
      email: () => mail,
      clock: () => NOW,
      desk: () => DESK,
    });
    expect(report).toEqual({ error: "desk alerts could not be sent" });
  });
});
