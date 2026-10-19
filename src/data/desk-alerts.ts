import type { QueryRunner } from "./db";
import type { EmailProvider } from "@/domain/messaging/provider";
import { logger } from "@/lib/logger";

/**
 * Desk alerts: telling a person about a problem the sweep found, by email to
 * the booking desk, until the problem goes away by itself.
 *
 * A problem is emailed when it first appears, again once a day while it
 * lasts, and closed without an email the run it disappears. Something is
 * recorded as sent only after the provider accepted it, so a send that
 * failed is tried again next run: the desk may, rarely, hear twice, and is
 * never left not hearing at all.
 *
 * Kind-generic on purpose: the refund alarm, a booked session's calendar
 * event deleted or moved by hand (the Outlook watch), a paid booking with no
 * session time, and a withdrawal waiting for a person's decision.
 */

export type DeskAlertKind =
  | "refund_needs_attention"
  | "calendar_event_changed"
  | "paid_booking_needs_time"
  | "withdrawal_needs_decision"
  | "payment_events_missing";

/** At most this many emails a run, failed tries included, so an outage cannot become a flood. */
export const MAX_ALERT_SENDS_PER_RUN = 10;

/** A problem still present this run. */
export interface DeskProblem {
  /** What the problem is about, e.g. `refund:<uuid>`. Ids only. */
  readonly subjectKey: string;
  /** The email for it; `reminder` when the desk has already been told once. */
  readonly render: (reminder: boolean) => Promise<{
    readonly subject: string;
    readonly html: string;
    readonly text: string;
  }>;
}

export type TransactionRunner = <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;

export interface DeskAlertDeps {
  /** Asked for only when there is something to send, so a quiet run needs no email set up. */
  readonly email: () => EmailProvider;
  readonly transaction: TransactionRunner;
  readonly clock: () => Date;
}

export interface DeskAlertReport {
  readonly raised: number;
  readonly reminded: number;
  readonly resolved: number;
  readonly failed: number;
}

const REMIND_AFTER_MS = 24 * 60 * 60_000;

/** A failed try waits this long before the next. */
const RETRY_AFTER_MS = 30 * 60_000;

/** How long a run holds an alert while it sends: far longer than one send can take. */
const CLAIM_MS = 5 * 60_000;

interface OpenAlert {
  readonly id: string;
  readonly subjectKey: string;
  readonly lastSentAt: Date | null;
  readonly lastAttemptAt: Date | null;
  readonly claimedUntil: Date | null;
}

async function listOpenAlerts(runner: QueryRunner, kind: DeskAlertKind): Promise<OpenAlert[]> {
  const result = await runner.query<{
    id: string;
    subject_key: string;
    last_sent_at: Date | null;
    last_attempt_at: Date | null;
    claimed_until: Date | null;
  }>(
    `select id, subject_key, last_sent_at, last_attempt_at, claimed_until from desk_alerts
      where kind = $1 and resolved_at is null`,
    [kind],
  );
  return result.rows.map((row) => ({
    id: row.id,
    subjectKey: row.subject_key,
    lastSentAt: row.last_sent_at,
    lastAttemptAt: row.last_attempt_at,
    claimedUntil: row.claimed_until,
  }));
}

/** Open the alert for a problem, or return the id of the one already open. */
async function openAlert(
  runner: QueryRunner,
  kind: DeskAlertKind,
  subjectKey: string,
  now: Date,
): Promise<string> {
  await runner.query(
    `insert into desk_alerts (kind, subject_key, first_raised_at, created_at, updated_at)
     values ($1, $2, $3, $3, $3)
     on conflict (kind, subject_key) where resolved_at is null do nothing`,
    [kind, subjectKey, now],
  );
  const result = await runner.query<{ id: string }>(
    `select id from desk_alerts where kind = $1 and subject_key = $2 and resolved_at is null`,
    [kind, subjectKey],
  );
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`desk alert for ${subjectKey} vanished as it was opened`);
  return id;
}

/**
 * Take an alert to send, if it is still due and nobody else holds it. The
 * same conditions as choosing it, checked again in one statement, so of two
 * overlapping runs only one gets the row. Returns how many emails it has
 * had, or null when it was not taken.
 */
async function claimAlert(runner: QueryRunner, id: string, now: Date): Promise<number | null> {
  const result = await runner.query<{ sends: number }>(
    `update desk_alerts
        set claimed_until = $3, last_attempt_at = $2, updated_at = $2
      where id = $1 and resolved_at is null
        and (claimed_until is null or claimed_until < $2)
        and (last_sent_at is null or last_sent_at <= $2::timestamptz - interval '24 hours')
        and (last_attempt_at is null or last_attempt_at <= $2::timestamptz - interval '30 minutes')
      returning sends`,
    [id, now, new Date(now.getTime() + CLAIM_MS)],
  );
  return result.rows[0]?.sends ?? null;
}

/** Whether an alert should be emailed now: never told, or told a day ago, and not tried in the last half hour. */
function dueNow(alert: OpenAlert | undefined, now: Date): boolean {
  if (alert === undefined) return true;
  const t = now.getTime();
  if (alert.claimedUntil !== null && alert.claimedUntil.getTime() >= t) return false;
  if (alert.lastSentAt !== null && t - alert.lastSentAt.getTime() < REMIND_AFTER_MS) return false;
  return alert.lastAttemptAt === null || t - alert.lastAttemptAt.getTime() >= RETRY_AFTER_MS;
}

/**
 * Bring the open alerts of one kind into line with the problems present now:
 * email the new ones, remind about the ones a day old, close the ones gone.
 */
export async function reconcileDeskAlerts(
  kind: DeskAlertKind,
  problems: readonly DeskProblem[],
  deps: DeskAlertDeps,
  deskAddress: string,
): Promise<DeskAlertReport> {
  const report = { raised: 0, reminded: 0, resolved: 0, failed: 0 };
  const open = await deps.transaction((runner) => listOpenAlerts(runner, kind));
  const present = new Set(problems.map((p) => p.subjectKey));

  // Gone by itself: closed quietly, the desk does not need telling twice.
  for (const alert of open) {
    if (present.has(alert.subjectKey)) continue;
    await deps.transaction((runner) =>
      runner.query(
        `update desk_alerts set resolved_at = $2, claimed_until = null, updated_at = $2
          where id = $1 and resolved_at is null`,
        [alert.id, deps.clock()],
      ),
    );
    report.resolved += 1;
  }

  /*
    The ones not tried for longest go first: never tried at all, then the
    oldest try. An alert whose sends keep failing cannot hold the cap and
    starve one raised after it.
  */
  const openByKey = new Map(open.map((a) => [a.subjectKey, a]));
  const lastTried = (p: DeskProblem) =>
    openByKey.get(p.subjectKey)?.lastAttemptAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const due = problems
    .filter((p) => dueNow(openByKey.get(p.subjectKey), deps.clock()))
    .toSorted((a, b) => lastTried(a) - lastTried(b))
    .slice(0, MAX_ALERT_SENDS_PER_RUN);

  let provider: EmailProvider | null = null;
  for (const problem of due) {
    const id =
      openByKey.get(problem.subjectKey)?.id ??
      (await deps.transaction((runner) =>
        openAlert(runner, kind, problem.subjectKey, deps.clock()),
      ));
    const sends = await deps.transaction((runner) => claimAlert(runner, id, deps.clock()));
    // Another run holds it, or it was sent a moment ago: not ours to send.
    if (sends === null) continue;

    provider ??= deps.email();
    // A reminder only once the desk has actually been told; a first send that failed is still the first.
    const reminder = sends > 0;
    const email = await problem.render(reminder);
    const result = await provider.send({
      to: deskAddress,
      subject: email.subject,
      html: email.html,
      text: email.text,
      /*
        Passed on as the port asks, but the email service does not dedupe on
        it. The claim above is what stops a second run sending the same email.
      */
      idempotencyKey: `desk-alert:${id}:${sends}`,
    });

    if (!result.ok) {
      await deps.transaction((runner) =>
        runner.query(`update desk_alerts set claimed_until = null where id = $1`, [id]),
      );
      report.failed += 1;
      logger.error("a desk alert could not be sent; it will be tried again in half an hour", {
        alertId: id,
        code: result.code,
      });
      continue;
    }
    await deps.transaction((runner) =>
      runner.query(
        `update desk_alerts
            set last_sent_at = $2, sends = sends + 1, claimed_until = null, updated_at = $2
          where id = $1`,
        [id, deps.clock()],
      ),
    );
    if (reminder) report.reminded += 1;
    else report.raised += 1;
  }
  return report;
}
