import {
  renderRefundIssued,
  renderTemplate,
  renderWithdrawalAcknowledgement,
  containsPlaceholder,
  TemplateNotAvailableError,
  type RenderedEmail,
} from "@/components/emails/templates";
import { SESSIONS, getSessionBySlug } from "@/config/sessions";
import { TRAINING_BASE, supportEmail } from "@/config/site";
import { withTransaction } from "@/data/db";
import {
  claimQueuedCommunication,
  loadCommunicationContext,
  markCommunicationCancelled,
  markCommunicationFailed,
  markCommunicationSent,
  requeueCommunication,
  type ClaimedCommunication,
  type CommunicationContext,
} from "@/data/communications";
import { loadWithdrawalRefund, refundStateForEmail } from "@/data/refund-queries";
import { loadWithdrawal } from "@/data/withdrawals";
import { bookingReference } from "@/domain/booking/withdrawal";
import { buildCalendarFile } from "@/domain/messaging/calendar-file";
import type { EmailAttachment, EmailProvider } from "@/domain/messaging/provider";
import { nextAttemptAt } from "@/domain/messaging/schedule";
import { decideSendTemplate, type TemplateKey } from "@/domain/messaging/sending-policy";
import { clientEnv, serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createManageToken } from "@/lib/manage-link";
import { termsPdfFor, termsPdfName } from "@/legal/terms-pdfs";

/**
 * Sending one queued message: render it from the current template, send it,
 * record what happened. Shared by the five-minute job and by the places a
 * message must go straight away (the acknowledgement of a withdrawal), so
 * both follow the same rules and the same claim keeps them from both sending.
 */

export type Outcome = "sent" | "retry" | "failed" | "withdrawn";

/** Messages about a withdrawal, which still go after the booking is cancelled. */
const ABOUT_A_WITHDRAWAL: ReadonlySet<TemplateKey> = new Set([
  "withdrawal_acknowledgement",
  "refund_issued",
]);

export interface SendNowInput {
  readonly bookingId: string;
  readonly templateKey: TemplateKey;
  readonly provider: EmailProvider;
  readonly now: Date;
}

/**
 * Send one booking's queued message now, instead of at the next run. It is
 * claimed exactly as the five-minute job claims it, so if that job reaches
 * the same row at the same moment only one of them sends. If this send fails
 * the row stays queued, and the job sends it as usual.
 */
export async function sendQueuedMessageNow(
  input: SendNowInput,
): Promise<Outcome | "nothing_queued"> {
  const row = await withTransaction((runner) =>
    claimQueuedCommunication(runner, input.bookingId, input.templateKey, input.now),
  );
  if (row === null) return "nothing_queued";
  return deliver(row, input.provider, input.now);
}

/**
 * One message, start to finish. Returns what happened; never throws for a
 * problem with the message itself.
 */
export async function deliver(
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
    marketingConsentConfirmedAt: context.marketingConsentConfirmedAt,
    unsubscribedAt: context.unsubscribedAt,
  });
  if (!decision.allowed) {
    return giveUp(row, `not_allowed: ${decision.reason}`, now);
  }

  /*
    A cancelled booking is owed nothing more about its session. Checked here as
    well as when it was cancelled, because a run may have claimed a reminder a
    moment before the cancellation withdrew it, and claiming leaves the row
    queued. Only the messages about the withdrawal itself still go.
  */
  if (context.bookingStatus === "cancelled" && !ABOUT_A_WITHDRAWAL.has(row.templateKey)) {
    await withTransaction((runner) => markCommunicationCancelled(runner, row.id));
    logger.info("message withdrawn: its booking is cancelled", {
      communicationId: row.id,
      templateKey: row.templateKey,
    });
    return "withdrawn";
  }

  const prepared =
    row.templateKey === "withdrawal_acknowledgement"
      ? await prepareWithdrawalAcknowledgement(context)
      : row.templateKey === "refund_issued"
        ? await prepareRefundIssued(context)
        : await prepareSessionEmail(row, context, now);
  if (!prepared.ok) return giveUp(row, prepared.reason, now);
  const { email } = prepared;

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
    ...(prepared.bcc ? { bcc: prepared.bcc } : {}),
    ...(prepared.attachments ? { attachments: prepared.attachments } : {}),
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

type Prepared =
  | {
      readonly ok: true;
      readonly email: RenderedEmail;
      readonly bcc?: string;
      readonly attachments?: readonly EmailAttachment[];
    }
  | { readonly ok: false; readonly reason: string };

/** A message about a session: it needs the session's time, and says nothing without one. */
async function prepareSessionEmail(
  row: ClaimedCommunication,
  context: CommunicationContext,
  now: Date,
): Promise<Prepared> {
  if (context.scheduledStart === null || context.scheduledEnd === null) {
    // Nothing about a session can be said until it has a time. A message
    // queued for a booking that lost its slot waits for a person, not a retry.
    return { ok: false, reason: "booking_has_no_time" };
  }

  const session = getSessionBySlug(context.sessionSlug);
  if (!session) return { ok: false, reason: "unknown_session" };

  try {
    const email = await renderTemplate(row.templateKey, {
      bookingId: context.bookingId,
      firstName: context.firstName,
      sessionTitle: session.title,
      durationMinutes: session.durationMinutes,
      slot: { start: context.scheduledStart, end: context.scheduledEnd },
      timeZone: context.customerTimezone,
      joinUrl: context.meetingUrl,
      nextSessionTitle: nextSessionTitle(session.displayOrder),
      agreement: context.agreement
        ? { ...context.agreement, amountPaidFils: context.amountPaidFils }
        : null,
      manageUrl:
        row.templateKey === "booking_confirmation" && context.rescheduleCount === 0
          ? manageUrlFor(context.bookingId, context.scheduledStart)
          : null,
    });
    if (row.templateKey === "payment_receipt") {
      // The terms exactly as agreed, as a fixed copy: a web page can change later.
      const version = context.agreement?.termsVersion ?? null;
      const pdf = version === null ? null : termsPdfFor(version);
      if (version !== null && pdf === null) {
        // Still sent: the email quotes the key terms and links the full ones.
        logger.error("no printed terms exist for this terms version; sent without the PDF", {
          termsVersion: version,
        });
      }
      return version !== null && pdf !== null
        ? {
            ok: true,
            email,
            attachments: [
              {
                name: termsPdfName(version),
                contentType: "application/pdf",
                content: pdf,
                encoding: "base64",
              },
            ],
          }
        : { ok: true, email };
    }
    if (
      row.templateKey !== "booking_confirmation" &&
      row.templateKey !== "reschedule_confirmation"
    ) {
      return { ok: true, email };
    }

    // The booking desk keeps a copy of each confirmed or moved booking in its
    // own inbox. Not the reminders: copies of those would bury that inbox.
    // The customer is never invited from the coach's mailbox, so these are
    // also where the session reaches their calendar. The file's sequence is
    // the move count, so the moved file replaces the first one.
    const calendarFile: EmailAttachment | null = context.meetingUrl
      ? {
          name: "zaaheen-session.ics",
          contentType: "text/calendar",
          content: buildCalendarFile({
            uid: `booking-${context.bookingId}@zaaheen.com`,
            sequence: context.rescheduleCount,
            start: context.scheduledStart,
            end: context.scheduledEnd,
            stamp: now,
            summary: `${session.title} (Zaaheen)`,
            description: [
              "Your private one-to-one session.",
              `Join on Microsoft Teams: ${context.meetingUrl}`,
              `Booking reference: ${bookingReference(context.bookingId)}`,
            ].join("\n"),
            url: context.meetingUrl,
          }),
        }
      : null;
    return {
      ok: true,
      email,
      bcc: supportEmail(),
      ...(calendarFile ? { attachments: [calendarFile] } : {}),
    };
  } catch (error) {
    if (error instanceof TemplateNotAvailableError) return { ok: false, reason: error.message };
    throw error;
  }
}

/**
 * The customer's own link to move the session, valid until it starts. Null
 * when no signing secret is configured: the email then says to reply instead,
 * rather than carry a link that cannot work.
 */
function manageUrlFor(bookingId: string, sessionStart: Date): string | null {
  const secret = serverEnv().MANAGE_LINK_SECRET;
  if (!secret) return null;
  const token = createManageToken({ bookingId, expiresAt: sessionStart }, secret);
  return `${clientEnv.NEXT_PUBLIC_SITE_URL}${TRAINING_BASE}/book/manage?t=${token}`;
}

/**
 * The acknowledgement of a withdrawal. About the notice, not a session, so it
 * goes whether or not the booking ever had a time. The booking desk gets a
 * blind copy, so a person sees every withdrawal and can check the refund and
 * the calendar. What it says about the money follows where the refund stands
 * at the moment it is sent.
 */
async function prepareWithdrawalAcknowledgement(context: CommunicationContext): Promise<Prepared> {
  const [withdrawal, refund] = await withTransaction((runner) =>
    Promise.all([
      loadWithdrawal(runner, context.bookingId),
      loadWithdrawalRefund(runner, context.bookingId),
    ]),
  );
  if (withdrawal === null) return { ok: false, reason: "no_withdrawal_on_record" };

  const session = getSessionBySlug(context.sessionSlug);
  if (!session) return { ok: false, reason: "unknown_session" };

  const email = await renderWithdrawalAcknowledgement({
    firstName: context.firstName,
    sessionTitle: session.title,
    reference: bookingReference(context.bookingId),
    statement: withdrawal.statement,
    receivedAt: withdrawal.receivedAt,
    timeZone: context.customerTimezone,
    refundDueFils: withdrawal.refundDueFils,
    refund: refundStateForEmail(refund),
  });
  return { ok: true, email, bcc: supportEmail() };
}

/**
 * That the refund a withdrawal was owed has been issued. Only the customer:
 * the desk already had a copy of the withdrawal, and Stripe shows the refund.
 */
async function prepareRefundIssued(context: CommunicationContext): Promise<Prepared> {
  const [withdrawal, refund] = await withTransaction((runner) =>
    Promise.all([
      loadWithdrawal(runner, context.bookingId),
      loadWithdrawalRefund(runner, context.bookingId),
    ]),
  );
  // Queued only once the refund was issued; anything else is a row a person should look at.
  if (withdrawal === null || refundStateForEmail(refund) === "owed") {
    return { ok: false, reason: "no_issued_refund_on_record" };
  }
  const email = await renderRefundIssued({
    firstName: context.firstName,
    reference: bookingReference(context.bookingId),
    amountFils: withdrawal.refundDueFils,
  });
  return { ok: true, email };
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
