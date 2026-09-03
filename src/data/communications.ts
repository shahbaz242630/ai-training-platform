import type { QueryRunner } from "./db";
import type { ScheduledMessage } from "@/domain/messaging/schedule";
import type { TemplateKey } from "@/domain/messaging/sending-policy";

/**
 * The queue of messages owed to customers, and what happened to each.
 *
 * A row is a promise: this booking is owed this template at this time. It is
 * written when the promise is made - at settlement, at confirmation - and
 * consumed by a job that runs every few minutes. The unique constraint on
 * (booking, template) means the promise can be made twice and kept once,
 * which is what a retried webhook needs.
 *
 * Claiming bumps `attempts` BEFORE the send. A process that dies mid-send
 * leaves a row that shows the attempt, and the retry hands the provider the
 * same idempotency key, so the customer gets one email either way.
 */

const CHANNEL = "email";

/** Queue every message for every booking on an order. Idempotent. Returns rows actually inserted. */
export async function queueForOrder(
  runner: QueryRunner,
  orderId: string,
  messages: readonly ScheduledMessage[],
): Promise<number> {
  let inserted = 0;
  for (const message of messages) {
    const result = await runner.query<{ id: string }>(
      `insert into communication_log (booking_id, channel, template_key, status, scheduled_for)
       select b.id, $2, $3, 'queued', $4
         from bookings b
        where b.order_id = $1
       on conflict (booking_id, template_key) do nothing
       returning id`,
      [orderId, CHANNEL, message.templateKey, message.scheduledFor],
    );
    inserted += result.rows.length;
  }
  return inserted;
}

/** Queue every message for one booking. Idempotent. Returns rows actually inserted. */
export async function queueForBooking(
  runner: QueryRunner,
  bookingId: string,
  messages: readonly ScheduledMessage[],
): Promise<number> {
  let inserted = 0;
  for (const message of messages) {
    const result = await runner.query<{ id: string }>(
      `insert into communication_log (booking_id, channel, template_key, status, scheduled_for)
       values ($1, $2, $3, 'queued', $4)
       on conflict (booking_id, template_key) do nothing
       returning id`,
      [bookingId, CHANNEL, message.templateKey, message.scheduledFor],
    );
    inserted += result.rows.length;
  }
  return inserted;
}

export interface ClaimedCommunication {
  readonly id: string;
  readonly bookingId: string;
  readonly templateKey: TemplateKey;
  /** Including the claim just made. */
  readonly attempts: number;
}

/**
 * Take the messages that are due, and mark each as attempted.
 *
 * `for update skip locked` so two overlapping runs divide the work rather
 * than both taking it. A bounded batch, so a backlog after an outage drains
 * over a few runs instead of one run holding every row at once.
 */
export async function claimDueCommunications(
  runner: QueryRunner,
  now: Date,
  limit: number,
): Promise<readonly ClaimedCommunication[]> {
  const result = await runner.query<{
    id: string;
    booking_id: string;
    template_key: TemplateKey;
    attempts: number;
  }>(
    `update communication_log
        set attempts = attempts + 1, last_attempt_at = $1
      where id in (
        select id
          from communication_log
         where status = 'queued' and channel = $3 and scheduled_for <= $1
         order by scheduled_for
         limit $2
         for update skip locked
      )
      returning id, booking_id, template_key, attempts`,
    [now, limit, CHANNEL],
  );
  return result.rows.map((row) => ({
    id: row.id,
    bookingId: row.booking_id,
    templateKey: row.template_key,
    attempts: row.attempts,
  }));
}

/** Everything a template needs to be rendered for one booking, and everything the send policy needs to allow it. */
export interface CommunicationContext {
  readonly bookingId: string;
  readonly bookingStatus: string;
  readonly sessionSlug: string;
  readonly scheduledStart: Date | null;
  readonly scheduledEnd: Date | null;
  readonly meetingUrl: string | null;
  readonly customerTimezone: string;
  readonly email: string;
  readonly firstName: string;
  readonly marketingConsent: boolean;
  readonly unsubscribedAt: Date | null;
}

export async function loadCommunicationContext(
  runner: QueryRunner,
  bookingId: string,
): Promise<CommunicationContext | null> {
  const result = await runner.query<{
    booking_id: string;
    status: string;
    session_slug: string;
    scheduled_start: Date | null;
    scheduled_end: Date | null;
    meeting_url: string | null;
    customer_timezone: string;
    email: string;
    first_name: string;
    marketing_consent: boolean;
    unsubscribed_at: Date | null;
  }>(
    `select b.id as booking_id, b.status, b.session_slug, b.scheduled_start, b.scheduled_end,
            b.meeting_url, b.customer_timezone,
            c.email, c.first_name, c.marketing_consent, c.unsubscribed_at
       from bookings b
       join orders o on o.id = b.order_id
       join customers c on c.id = o.customer_id
      where b.id = $1`,
    [bookingId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    bookingId: row.booking_id,
    bookingStatus: row.status,
    sessionSlug: row.session_slug,
    scheduledStart: row.scheduled_start,
    scheduledEnd: row.scheduled_end,
    meetingUrl: row.meeting_url,
    customerTimezone: row.customer_timezone,
    email: row.email,
    firstName: row.first_name,
    marketingConsent: row.marketing_consent,
    unsubscribedAt: row.unsubscribed_at,
  };
}

export async function markCommunicationSent(
  runner: QueryRunner,
  id: string,
  providerMessageId: string,
  now: Date,
): Promise<void> {
  await runner.query(
    `update communication_log
        set status = 'sent', provider_message_id = $2, sent_at = $3, last_error = null
      where id = $1`,
    [id, providerMessageId, now],
  );
}

/** Give up on it. Left for a person, with the last reason attached. */
export async function markCommunicationFailed(
  runner: QueryRunner,
  id: string,
  errorCode: string,
  now: Date,
): Promise<void> {
  await runner.query(
    `update communication_log
        set status = 'failed', error_code = $2, last_error = $2, failed_at = $3
      where id = $1`,
    [id, errorCode, now],
  );
}

/** Try again later. Stays queued, so the next run that finds it due picks it up. */
export async function requeueCommunication(
  runner: QueryRunner,
  id: string,
  scheduledFor: Date,
  errorCode: string,
): Promise<void> {
  await runner.query(
    `update communication_log set scheduled_for = $2, last_error = $3 where id = $1`,
    [id, scheduledFor, errorCode],
  );
}

/** Withdraw everything still owed to a booking. For a reschedule or a cancellation. Returns rows withdrawn. */
export async function cancelQueuedCommunications(
  runner: QueryRunner,
  bookingId: string,
): Promise<number> {
  const result = await runner.query<{ id: string }>(
    `update communication_log set status = 'cancelled'
      where booking_id = $1 and status = 'queued'
      returning id`,
    [bookingId],
  );
  return result.rows.length;
}

/** How many messages have been given up on. A standing alarm, counted rather than listed. */
export async function countFailedCommunications(runner: QueryRunner): Promise<number> {
  const result = await runner.query<{ n: string }>(
    `select count(*)::text as n from communication_log where status = 'failed'`,
  );
  return Number(result.rows[0]?.n ?? 0);
}
