import { NextResponse } from "next/server";
import {
  renderTemplate,
  containsPlaceholder,
  TemplateNotAvailableError,
} from "@/components/emails/templates";
import { SESSIONS, getSessionBySlug } from "@/config/sessions";
import { withTransaction } from "@/data/db";
import {
  claimDueCommunications,
  countFailedCommunications,
  loadCommunicationContext,
  markCommunicationFailed,
  markCommunicationSent,
  requeueCommunication,
  type ClaimedCommunication,
} from "@/data/communications";
import { getEmailProvider } from "@/domain/messaging/factory";
import type { EmailProvider } from "@/domain/messaging/provider";
import { nextAttemptAt } from "@/domain/messaging/schedule";
import { decideSendTemplate } from "@/domain/messaging/sending-policy";
import { authoriseCronRequest } from "@/lib/cron-auth";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

/**
 * Send what is due.
 *
 * Called every five minutes by a database-scheduled job that carries a shared
 * secret. It takes a bounded batch of queued messages whose time has come,
 * renders each from the current template, sends it, and records the result.
 *
 * TWO RULES SHAPE EVERYTHING HERE:
 *
 *   A failed send never breaks a booking. Every failure is recorded against
 *   its own row and the loop moves on. Only the infrastructure failing - no
 *   database, no provider configured - fails the run, and it fails with a
 *   500 so it is never mistaken for a quiet period.
 *
 *   A customer gets one email, not two. The row is claimed and its attempt
 *   counted BEFORE the send, and the provider is handed the row id as an
 *   idempotency key, so a retry after a crash presents the same key and the
 *   provider delivers nothing new.
 */

export const dynamic = "force-dynamic";

/** Enough to drain a normal five minutes many times over; small enough that a backlog drains in steps. */
const BATCH_SIZE = 50;

type Outcome = "sent" | "retry" | "failed";

export async function POST(request: Request): Promise<NextResponse> {
  const auth = authoriseCronRequest(request.headers.get("authorization"), serverEnv().CRON_SECRET);

  if (auth === "not_configured") {
    logger.error("cron secret is not configured, so no messages can be sent");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }
  if (auth === "unauthorised") {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let provider: EmailProvider;
  try {
    provider = getEmailProvider();
  } catch {
    /*
      Nothing is claimed while email is unconfigured. The queue waits, which
      is recoverable; a run that claimed rows and could not send them would
      count attempts against messages nobody tried to send.
    */
    logger.error("email is not configured, so queued messages are waiting");
    return NextResponse.json({ error: "Email not configured" }, { status: 500 });
  }

  const now = new Date();

  try {
    const claimed = await withTransaction((runner) =>
      claimDueCommunications(runner, now, BATCH_SIZE),
    );

    const outcomes: Record<Outcome, number> = { sent: 0, retry: 0, failed: 0 };
    for (const row of claimed) {
      outcomes[await deliver(row, provider, now)] += 1;
    }

    const failedInTotal = await withTransaction((runner) => countFailedCommunications(runner));
    if (failedInTotal > 0) {
      /*
        A standing alarm, on every run, until somebody deals with it. These
        are messages a customer was promised and will not get without a
        human - the same shape as a paid booking with no slot.
      */
      logger.error("messages have been given up on and need a person", { failed: failedInTotal });
    }

    return NextResponse.json({ ok: true, claimed: claimed.length, ...outcomes, failedInTotal });
  } catch (error) {
    logger.error("the send run could not complete", { error: (error as Error).message });
    return NextResponse.json({ error: "Send run failed" }, { status: 500 });
  }
}

/**
 * One message, start to finish. Returns what happened; never throws for a
 * problem with the message itself.
 */
async function deliver(
  row: ClaimedCommunication,
  provider: EmailProvider,
  now: Date,
): Promise<Outcome> {
  const context = await withTransaction((runner) =>
    loadCommunicationContext(runner, row.bookingId),
  );

  if (context === null) {
    return giveUp(row, "no_such_booking", now);
  }

  /*
    Classified before anything is rendered. The caller passes the template
    key, never a kind, so a message cannot declare itself transactional to
    get past the check - and an unclassified key is refused outright.
  */
  const decision = decideSendTemplate(row.templateKey, {
    marketingConsent: context.marketingConsent,
    unsubscribedAt: context.unsubscribedAt,
  });
  if (!decision.allowed) {
    return giveUp(row, `not_allowed: ${decision.reason}`, now);
  }

  if (context.scheduledStart === null || context.scheduledEnd === null) {
    // Nothing about a session can be said until it has a time. A message
    // queued for a booking that lost its slot waits for a person, not a retry.
    return giveUp(row, "booking_has_no_time", now);
  }

  const session = getSessionBySlug(context.sessionSlug);
  if (!session) {
    return giveUp(row, "unknown_session", now);
  }

  let email;
  try {
    email = await renderTemplate(row.templateKey, {
      firstName: context.firstName,
      sessionTitle: session.title,
      durationMinutes: session.durationMinutes,
      slot: { start: context.scheduledStart, end: context.scheduledEnd },
      timeZone: context.customerTimezone,
      joinUrl: context.meetingUrl,
      nextSessionTitle: nextSessionTitle(session.displayOrder),
    });
  } catch (error) {
    if (error instanceof TemplateNotAvailableError) return giveUp(row, error.message, now);
    throw error;
  }

  /*
    An identity placeholder in a customer's inbox would be worse than no
    email. Refused here, and it stays refused until the configuration is real
    - a retry cannot fix a placeholder.
  */
  if (containsPlaceholder(email)) {
    return giveUp(row, "placeholder_in_content", now);
  }

  const result = await provider.send({
    to: context.email,
    subject: email.subject,
    html: email.html,
    text: email.text,
    idempotencyKey: `communication:${row.id}`,
  });

  if (result.ok) {
    await withTransaction((runner) =>
      markCommunicationSent(runner, row.id, result.providerMessageId, now),
    );
    logger.info("message sent", { communicationId: row.id, templateKey: row.templateKey });
    return "sent";
  }

  const again = result.retryable ? nextAttemptAt(row.attempts, now) : null;
  if (again === null) {
    return giveUp(row, result.code, now);
  }

  await withTransaction((runner) => requeueCommunication(runner, row.id, again, result.code));
  logger.warn("message send failed, will retry", {
    communicationId: row.id,
    templateKey: row.templateKey,
    code: result.code,
    attempts: row.attempts,
    nextAttemptAt: again.toISOString(),
  });
  return "retry";
}

async function giveUp(row: ClaimedCommunication, reason: string, now: Date): Promise<Outcome> {
  await withTransaction((runner) => markCommunicationFailed(runner, row.id, reason, now));
  logger.error("message could not be sent and has been left for a person", {
    communicationId: row.id,
    templateKey: row.templateKey,
    reason,
  });
  return "failed";
}

/** The catalogue's next step after this session, by display order, when there is one that can be booked. */
function nextSessionTitle(displayOrder: number): string | null {
  const next = SESSIONS.find((session) => session.displayOrder === displayOrder + 1);
  return next?.active ? next.title : null;
}
