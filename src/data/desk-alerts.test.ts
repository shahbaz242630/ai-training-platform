import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import { MAX_ALERT_SENDS_PER_RUN, reconcileDeskAlerts, type DeskProblem } from "./desk-alerts";
import { MockEmailProvider } from "@/domain/messaging/mock-provider";

/**
 * Telling a person. A problem the sweep finds is emailed to the booking desk
 * once, then once a day while it lasts, and goes quiet the run it is gone.
 * A send that fails is tried again next run, and is never recorded as sent.
 */

let db: PGlite;
let runner: QueryRunner;
const NOW = new Date("2026-10-16T12:00:00Z");
const HOUR = 60 * 60_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR);
const transaction = <T>(work: (r: QueryRunner) => Promise<T>) => work(runner);
const DESK = "desk@example.com";

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

beforeEach(async () => {
  await db.query(`delete from desk_alerts`);
});

const problem = (key: string): DeskProblem => ({
  subjectKey: key,
  render: (reminder) =>
    Promise.resolve({
      subject: `${reminder ? "Reminder: " : ""}Problem ${key}`,
      html: `<p>${key}</p>`,
      text: key,
    }),
});

async function run(problems: readonly DeskProblem[], email: MockEmailProvider, now: Date) {
  return reconcileDeskAlerts(
    "refund_needs_attention",
    problems,
    { email: () => email, transaction, clock: () => now },
    DESK,
  );
}

async function alertFor(key: string) {
  const result = await db.query<{
    sends: number;
    last_sent_at: Date | null;
    resolved_at: Date | null;
  }>(`select sends, last_sent_at, resolved_at from desk_alerts where subject_key = $1`, [key]);
  return result.rows;
}

describe("reconcileDeskAlerts", () => {
  it("raises a new problem: one email to the desk and one open alert", async () => {
    const email = new MockEmailProvider();
    const report = await run([problem("refund:a")], email, NOW);

    expect(report).toEqual({ raised: 1, reminded: 0, resolved: 0, failed: 0 });
    expect(email.sent.map((m) => [m.to, m.subject])).toEqual([[DESK, "Problem refund:a"]]);
    expect(await alertFor("refund:a")).toEqual([
      { sends: 1, last_sent_at: NOW, resolved_at: null },
    ]);
  });

  // One alert that cannot be written must not stop the ones behind it.
  it("carries on past an alert that cannot be written, and tries that one again later", async () => {
    const email = new MockEmailProvider();
    const broken: DeskProblem = {
      subjectKey: "refund:broken",
      render: () => Promise.reject(new Error("template exploded")),
    };

    const report = await run([broken, problem("refund:fine")], email, NOW);

    expect(report).toMatchObject({ raised: 1, failed: 1 });
    expect(email.sent.map((m) => m.subject)).toEqual(["Problem refund:fine"]);
    expect(await alertFor("refund:broken")).toEqual([
      { sends: 0, last_sent_at: null, resolved_at: null },
    ]);
  });

  it("says nothing more about the same problem within a day", async () => {
    const email = new MockEmailProvider();
    await run([problem("refund:b")], email, NOW);
    const report = await run([problem("refund:b")], email, at(23));
    expect(report).toEqual({ raised: 0, reminded: 0, resolved: 0, failed: 0 });
    expect(email.sent).toHaveLength(1);
  });

  it("reminds the desk once a day while the problem lasts", async () => {
    const email = new MockEmailProvider();
    await run([problem("refund:c")], email, NOW);
    const report = await run([problem("refund:c")], email, at(24.1));
    expect(report).toMatchObject({ reminded: 1 });
    expect(email.sent.map((m) => m.subject)).toEqual([
      "Problem refund:c",
      "Reminder: Problem refund:c",
    ]);
    expect(await alertFor("refund:c")).toEqual([
      { sends: 2, last_sent_at: at(24.1), resolved_at: null },
    ]);
  });

  it("records nothing as sent when the send fails, and tries again half an hour later", async () => {
    const email = new MockEmailProvider();
    email.failNext({ ok: false, code: "network", message: "down", retryable: true });
    const first = await run([problem("refund:d")], email, NOW);
    expect(first).toMatchObject({ raised: 0, failed: 1 });
    expect(await alertFor("refund:d")).toEqual([
      { sends: 0, last_sent_at: null, resolved_at: null },
    ]);

    // Not on the very next run: a failed try waits half an hour.
    const soon = await run([problem("refund:d")], email, at(0.25));
    expect(soon).toEqual({ raised: 0, reminded: 0, resolved: 0, failed: 0 });

    const second = await run([problem("refund:d")], email, at(0.6));
    expect(second).toMatchObject({ raised: 1, failed: 0 });
    // The first email that actually went is the first one, not a reminder.
    expect(email.sent.map((m) => m.subject)).toEqual(["Problem refund:d"]);
  });

  it("closes the alert the run the problem is gone, without an email", async () => {
    const email = new MockEmailProvider();
    await run([problem("refund:e")], email, NOW);
    const report = await run([], email, at(1));
    expect(report).toEqual({ raised: 0, reminded: 0, resolved: 1, failed: 0 });
    expect(email.sent).toHaveLength(1);
    expect(await alertFor("refund:e")).toEqual([
      { sends: 1, last_sent_at: NOW, resolved_at: at(1) },
    ]);
  });

  it("raises it afresh if the same problem comes back after it was closed", async () => {
    const email = new MockEmailProvider();
    await run([problem("refund:f")], email, NOW);
    await run([], email, at(1));
    const report = await run([problem("refund:f")], email, at(2));
    expect(report).toMatchObject({ raised: 1 });
    expect(await alertFor("refund:f")).toHaveLength(2);
  });

  it(`sends at most ${MAX_ALERT_SENDS_PER_RUN} emails a run, and the rest next run`, async () => {
    const email = new MockEmailProvider();
    const many = Array.from({ length: MAX_ALERT_SENDS_PER_RUN + 3 }, (_, i) =>
      problem(`refund:m${i}`),
    );
    const first = await run(many, email, NOW);
    expect(first.raised).toBe(MAX_ALERT_SENDS_PER_RUN);
    expect(email.sent).toHaveLength(MAX_ALERT_SENDS_PER_RUN);
    const second = await run(many, email, at(0.1));
    expect(second.raised).toBe(3);
    expect(email.sent).toHaveLength(MAX_ALERT_SENDS_PER_RUN + 3);
  });

  it("counts a failed send against the cap, so an outage cannot become a flood of tries", async () => {
    const email = new MockEmailProvider();
    for (let i = 0; i < MAX_ALERT_SENDS_PER_RUN + 2; i += 1) {
      email.failNext({ ok: false, code: "network", message: "down", retryable: true });
    }
    const many = Array.from({ length: MAX_ALERT_SENDS_PER_RUN + 2 }, (_, i) =>
      problem(`refund:o${i}`),
    );
    const report = await run(many, email, NOW);
    expect(report.failed).toBe(MAX_ALERT_SENDS_PER_RUN);
  });

  /*
    Two sweep runs overlapping (a slow run, and the next one five minutes
    later) must not both email. Graph does not dedupe on our key, so the
    claim on the alert row is the only thing that stops it.
  */
  it("emails once when two runs reach the same alert at the same time", async () => {
    const email = new MockEmailProvider();
    const slow = {
      send: async (message: Parameters<MockEmailProvider["send"]>[0]) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return email.send({
          ...message,
          idempotencyKey: `${message.idempotencyKey}:${Math.random()}`,
        });
      },
    };
    const race = () =>
      reconcileDeskAlerts(
        "refund_needs_attention",
        [problem("refund:race")],
        { email: () => slow, transaction, clock: () => NOW },
        DESK,
      );
    const [a, b] = await Promise.all([race(), race()]);
    expect(a.raised + b.raised).toBe(1);
    expect(email.sent).toHaveLength(1);
  });

  it("does not let a failing alert keep newer ones from being sent", async () => {
    const email = new MockEmailProvider();
    const old = Array.from({ length: MAX_ALERT_SENDS_PER_RUN }, (_, i) => problem(`refund:x${i}`));
    for (let i = 0; i < MAX_ALERT_SENDS_PER_RUN; i += 1) {
      email.failNext({ ok: false, code: "network", message: "down", retryable: true });
    }
    await run(old, email, NOW);

    // Ten minutes on, the failed ones are waiting out their half hour; the new one goes.
    const report = await run([...old, problem("refund:new")], email, at(10 / 60));
    expect(report).toMatchObject({ raised: 1, failed: 0 });
    expect(email.sent.map((m) => m.subject)).toEqual(["Problem refund:new"]);
  });

  it("tries the alerts not tried recently first, so none is starved by the cap", async () => {
    const email = new MockEmailProvider();
    const all = Array.from({ length: MAX_ALERT_SENDS_PER_RUN + 2 }, (_, i) =>
      problem(`refund:y${i}`),
    );
    for (let i = 0; i < MAX_ALERT_SENDS_PER_RUN; i += 1) {
      email.failNext({ ok: false, code: "network", message: "down", retryable: true });
    }
    await run(all, email, NOW);

    // Half an hour on, all twelve are due; the two never tried are among this run's ten.
    await run(all, email, at(0.6));
    const sent = email.sent.map((m) => m.subject);
    expect(sent).toHaveLength(MAX_ALERT_SENDS_PER_RUN);
    expect(sent).toContain(`Problem refund:y${MAX_ALERT_SENDS_PER_RUN}`);
    expect(sent).toContain(`Problem refund:y${MAX_ALERT_SENDS_PER_RUN + 1}`);
  });

  it("does not need email at all on a run with nothing to send", async () => {
    const report = await reconcileDeskAlerts(
      "refund_needs_attention",
      [],
      {
        email: () => {
          throw new Error("should not be asked for");
        },
        transaction,
        clock: () => NOW,
      },
      DESK,
    );
    expect(report).toEqual({ raised: 0, reminded: 0, resolved: 0, failed: 0 });
  });
});
