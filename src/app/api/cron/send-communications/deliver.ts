import { createHash } from "node:crypto";
import {
  renderCancellationConfirmation,
  renderChooseNewTime,
  renderNextSession,
  renderPaymentReceivedNoTime,
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
  customerHasBookedAny,
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
import {
  decideSendTemplate,
  TEMPLATE_KINDS,
  type TemplateKey,
} from "@/domain/messaging/sending-policy";
import { clientEnv, serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createEmailLinkToken, emailLinkKeys } from "@/lib/email-link";
import { createManageToken } from "@/lib/manage-link";
import { addDays } from "@/lib/time";
import { CHOOSE_TIME_LINK_DAYS } from "@/components/emails/desk-alerts";
import { termsPdfFor, termsPdfName } from "@/legal/terms-pdfs";

/**
 * Sending one queued message: render it from the current template, send it,
 * record what happened. Shared by the five-minute job and by the places a
 * message must go straight away (the acknowledgement of a withdrawal), so
 * both follow the same rules and the same claim keeps them from both sending.
 */

export type Outcome = "sent" | "retry" | "failed" | "withdrawn";

/** Messages about the cancellation itself, which still go after the booking is cancelled. */
const ABOUT_A_WITHDRAWAL: ReadonlySet<TemplateKey> = new Set([
  "withdrawal_acknowledgement",
  "refund_issued",
  "cancellation_confirmation",
]);

/** The two emails about the next session in the series. */
const NEXT_SESSION: ReadonlySet<TemplateKey> = new Set([
  "next_session_nudge_1",
  "next_session_nudge_2",
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
    /*
      Marketing is queued for everybody and decided when due: consent may be
      confirmed in the meantime, or withdrawn. Not being allowed is then the
      ordinary outcome, not a fault, so it is withdrawn quietly rather than
      left for a person. Anything else refused is still a fault.
    */
    if (TEMPLATE_KINDS[row.templateKey] === "marketing") {
      await withTransaction((runner) => markCommunicationCancelled(runner, row.id));
      logger.info("marketing message not sent", {
        communicationId: row.id,
        templateKey: row.templateKey,
        reason: decision.reason,
      });
      return "withdrawn";
    }
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
        : row.templateKey === "cancellation_confirmation"
          ? await prepareCancellationConfirmation(context)
          : row.templateKey === "choose_new_time"
            ? await prepareChooseNewTime(context, now)
            : NEXT_SESSION.has(row.templateKey)
              ? await prepareNextSession(row.templateKey, context)
              : row.templateKey === "payment_receipt" && context.scheduledStart === null
                ? await preparePaymentReceivedNoTime(context)
                : await prepareSessionEmail(row, context, now);
  if (!prepared.ok && prepared.withdraw) {
    // No longer true by the time it would go: nothing wrong, nothing to retry.
    await withTransaction((runner) => markCommunicationCancelled(runner, row.id));
    logger.info("message withdrawn before sending", {
      communicationId: row.id,
      templateKey: row.templateKey,
      reason: prepared.reason,
    });
    return "withdrawn";
  }
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
  | { readonly ok: false; readonly reason: string; readonly withdraw?: boolean };

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
      moved: context.rescheduleCount > 0,
      confirmEmailsUrl:
        row.templateKey === "booking_confirmation" ? confirmEmailsUrlFor(context) : null,
    });
    if (row.templateKey === "payment_receipt")
      return { ok: true, email, ...termsAttachment(context) };
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
            uid: calendarUid(context.bookingId),
            sequence: context.rescheduleCount,
            start: context.scheduledStart,
            end: context.scheduledEnd,
            stamp: now,
            summary: `${session.title} (Zaaheen)`,
            /*
              No booking reference (audit s101 L3): calendars are often shared,
              and the reference with the owner's email is all the withdrawal
              form asks for. The reference stays in the emails themselves.
            */
            description: [
              "Your private one-to-one session.",
              `Join on Microsoft Teams: ${context.meetingUrl}`,
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
 * The calendar file's identity for a booking: the same on every file about it,
 * so a moved session replaces the first, but one-way. The booking id itself
 * would give away the booking reference (its first eight characters), and
 * calendars are shared (audit s101 L3).
 */
export function calendarUid(bookingId: string): string {
  const digest = createHash("sha256").update(`zaaheen-booking:${bookingId}`).digest("hex");
  return `booking-${digest.slice(0, 32)}@zaaheen.com`;
}

/** The terms exactly as agreed, as a fixed copy for the payment acknowledgement: a web page can change later. */
function termsAttachment(context: CommunicationContext): {
  readonly attachments?: readonly EmailAttachment[];
} {
  const version = context.agreement?.termsVersion ?? null;
  if (version === null) return {};
  const pdf = termsPdfFor(version);
  if (pdf === null) {
    // Still sent: the email quotes the key terms and links the full ones.
    logger.error("no printed terms exist for this terms version; sent without the PDF", {
      termsVersion: version,
    });
    return {};
  }
  return {
    attachments: [
      {
        name: termsPdfName(version),
        contentType: "application/pdf",
        content: pdf,
        encoding: "base64",
      },
    ],
  };
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
 * The link that confirms the occasional emails about new sessions, offered
 * only while the customer asked for them and has neither confirmed nor
 * withdrawn. Null without the email-link secret, like the booking link.
 */
export function confirmEmailsUrlFor(
  context: Pick<
    CommunicationContext,
    "customerId" | "marketingConsent" | "marketingConsentConfirmedAt" | "unsubscribedAt"
  >,
): string | null {
  if (!context.marketingConsent) return null;
  if (context.marketingConsentConfirmedAt !== null || context.unsubscribedAt !== null) return null;
  const env = serverEnv();
  const secret = emailLinkKeys(env.EMAIL_LINK_SECRET, env.EMAIL_LINK_SECRET_PREVIOUS).sign;
  if (!secret) return null;
  const token = createEmailLinkToken(
    { purpose: "confirm", customerId: context.customerId },
    secret,
  );
  return `${clientEnv.NEXT_PUBLIC_SITE_URL}${TRAINING_BASE}/book/email/confirm?t=${token}`;
}

/**
 * One of the two emails about the next session in the series. Checked again
 * when due: withdrawn when the catalogue has no next session after this one
 * (Session 6), or the customer already has a booking for it or anything
 * further on. It cannot go without its unsubscribe link, so a missing link
 * secret is a fault for a person, not a quiet skip.
 */
async function prepareNextSession(
  templateKey: TemplateKey,
  context: CommunicationContext,
): Promise<Prepared> {
  const session = getSessionBySlug(context.sessionSlug);
  if (!session) return { ok: false, reason: "unknown_session" };
  const next = SESSIONS.find((s) => s.displayOrder === session.displayOrder + 1);
  if (!next?.active) return { ok: false, reason: "no_next_session", withdraw: true };

  const furtherOn = SESSIONS.filter((s) => s.displayOrder >= next.displayOrder).map((s) => s.slug);
  const booked = await withTransaction((runner) =>
    customerHasBookedAny(runner, context.customerId, furtherOn),
  );
  if (booked) return { ok: false, reason: "already_booked_further_on", withdraw: true };

  const env = serverEnv();
  const secret = emailLinkKeys(env.EMAIL_LINK_SECRET, env.EMAIL_LINK_SECRET_PREVIOUS).sign;
  if (!secret) return { ok: false, reason: "no_email_link_secret" };
  const unsubscribe = createEmailLinkToken(
    { purpose: "unsubscribe", customerId: context.customerId },
    secret,
  );
  const site = `${clientEnv.NEXT_PUBLIC_SITE_URL}${TRAINING_BASE}`;
  return {
    ok: true,
    email: await renderNextSession({
      which: templateKey === "next_session_nudge_1" ? 1 : 2,
      firstName: context.firstName,
      sessionTitle: session.title,
      nextSessionTitle: next.title,
      nextSessionSummary: next.summary,
      nextSessionUrl: `${site}/book/${next.slug}`,
      unsubscribeUrl: `${site}/book/email/unsubscribe?t=${unsubscribe}`,
    }),
  };
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
    // A notice the desk decides has no refund of its own: a person makes it, if it is owed.
    refund: withdrawal.route === "desk" && refund === null ? "review" : refundStateForEmail(refund),
  });
  return { ok: true, email, bcc: supportEmail() };
}

/**
 * That a full refund cancelled the booking. Queued only by that cancellation;
 * a booking still open means something else happened, and a person looks.
 * The desk gets a copy: it is the record that the customer was told.
 */
async function prepareCancellationConfirmation(context: CommunicationContext): Promise<Prepared> {
  if (context.bookingStatus !== "cancelled") return { ok: false, reason: "booking_not_cancelled" };
  const session = getSessionBySlug(context.sessionSlug);
  if (!session) return { ok: false, reason: "unknown_session" };
  const email = await renderCancellationConfirmation({
    firstName: context.firstName,
    bookingId: context.bookingId,
    sessionTitle: session.title,
    slot:
      context.scheduledStart && context.scheduledEnd
        ? { start: context.scheduledStart, end: context.scheduledEnd }
        : null,
    timeZone: context.customerTimezone,
    refundedFils: context.amountPaidFils,
  });
  return { ok: true, email, bcc: supportEmail() };
}

/**
 * The customer's link to choose a time for a paid booking that has none
 * (founder decision, October 2026). Checked again at sending: if the booking
 * has a time by now, is no longer exactly paid, or the order has ever been
 * disputed, it is withdrawn. After a dispute the person with the booking may
 * not be the cardholder, so a person decides instead. The desk gets a copy:
 * it is the record that the customer was told.
 */
async function prepareChooseNewTime(context: CommunicationContext, now: Date): Promise<Prepared> {
  if (context.bookingStatus !== "awaiting_schedule") {
    return { ok: false, reason: "booking_not_waiting", withdraw: true };
  }
  if (!context.orderFullyPaid) return { ok: false, reason: "order_not_paid", withdraw: true };
  if (context.orderDisputed) return { ok: false, reason: "order_disputed", withdraw: true };
  const session = getSessionBySlug(context.sessionSlug);
  if (!session) return { ok: false, reason: "unknown_session" };
  const secret = serverEnv().MANAGE_LINK_SECRET;
  if (!secret) return { ok: false, reason: "no_link_secret" };
  const token = createManageToken(
    { bookingId: context.bookingId, expiresAt: addDays(now, CHOOSE_TIME_LINK_DAYS) },
    secret,
  );
  return {
    ok: true,
    email: await renderChooseNewTime({
      bookingId: context.bookingId,
      firstName: context.firstName,
      sessionTitle: session.title,
      chooseTimeUrl: `${clientEnv.NEXT_PUBLIC_SITE_URL}${TRAINING_BASE}/book/manage?t=${token}`,
      linkDays: CHOOSE_TIME_LINK_DAYS,
    }),
    bcc: supportEmail(),
  };
}

/**
 * The payment acknowledgement for a payment that arrived after its time had
 * gone: still sent at once, with the terms attached, so the contract is
 * confirmed in writing whatever happens to the time.
 */
async function preparePaymentReceivedNoTime(context: CommunicationContext): Promise<Prepared> {
  const session = getSessionBySlug(context.sessionSlug);
  if (!session) return { ok: false, reason: "unknown_session" };
  const email = await renderPaymentReceivedNoTime({
    bookingId: context.bookingId,
    firstName: context.firstName,
    sessionTitle: session.title,
    agreement: context.agreement
      ? { ...context.agreement, amountPaidFils: context.amountPaidFils }
      : null,
  });
  return { ok: true, email, ...termsAttachment(context) };
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
