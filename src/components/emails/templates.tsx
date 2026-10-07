import { render } from "@react-email/render";
import {
  BOOKING_POLICY,
  POLICY_LINKS,
  TRAINING_BASE,
  companyName,
  supportEmail,
} from "@/config/site";
import { bookingReference } from "@/domain/booking/withdrawal";
import { clientEnv } from "@/lib/env";
import type { TemplateKey } from "@/domain/messaging/sending-policy";
import { describeInstant, presentSlots } from "@/domain/scheduling/slot-presentation";
import { formatAed, type Fils } from "@/lib/money";
import {
  WithdrawalAcknowledgementEmail,
  withdrawalAcknowledgementSubject,
} from "./WithdrawalAcknowledgementEmail";
import { BookingConfirmationEmail, bookingConfirmationSubject } from "./BookingConfirmationEmail";
import { FollowUpEmail, followUpSubject } from "./FollowUpEmail";
import { PaymentReceivedEmail, paymentReceivedSubject } from "./PaymentReceivedEmail";
import { ReminderEmail, reminderSubject } from "./ReminderEmail";

/**
 * From a template key and the facts about a booking to a sendable email.
 *
 * The queue stores a key, not content, so what a customer reads is whatever
 * the template says at the moment of sending - a correction to the copy
 * reaches messages already queued. Rendering happens here, once, to both HTML
 * and plain text, and the result is what the provider is handed verbatim.
 *
 * Times are converted exactly once, through the same presentation the booking
 * page uses, so the email and the page a customer booked from can never
 * disagree about when the session is.
 */

export interface SessionEmailModel {
  /** The booking this message is about; its reference is quoted to customers. */
  readonly bookingId: string;
  readonly firstName: string;
  readonly sessionTitle: string;
  readonly durationMinutes: number;
  readonly slot: { readonly start: Date; readonly end: Date };
  /** The customer's zone, as captured at booking. */
  readonly timeZone: string;
  readonly joinUrl: string | null;
  /** What was paid and agreed, for the payment acknowledgement; from the stored consent record. */
  readonly agreement?: AgreementModel | null;
  /** The catalogue's natural next step after this session, if it has one. */
  readonly nextSessionTitle: string | null;
}

export interface AgreementModel {
  readonly amountPaidFils: Fils;
  readonly termsVersion: string;
  readonly keyTerms: readonly string[];
  readonly expressRequestText: string | null;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** The key names a message we have no template for, or one that cannot be honestly rendered from this model. */
export class TemplateNotAvailableError extends Error {
  constructor(templateKey: string, reason: string) {
    super(`${templateKey} cannot be rendered: ${reason}`);
    this.name = "TemplateNotAvailableError";
  }
}

/**
 * The identity placeholders are an upper-case name in square brackets. One in a
 * customer's inbox would be worse than no email, so a rendered message is
 * checked for the pattern before it is allowed anywhere near a provider.
 */
const PLACEHOLDER = /\[[A-Z][A-Z_]+\]/;

export function containsPlaceholder(email: RenderedEmail): boolean {
  return PLACEHOLDER.test(email.subject) || PLACEHOLDER.test(email.text);
}

export async function renderTemplate(
  templateKey: TemplateKey,
  model: SessionEmailModel,
): Promise<RenderedEmail> {
  const [day] = presentSlots([model.slot], model.timeZone);
  const presented = day?.slots[0];
  if (!day || !presented) {
    throw new TemplateNotAvailableError(templateKey, "the slot could not be presented");
  }

  const details = {
    sessionTitle: model.sessionTitle,
    dayLabel: day.label,
    localTime: presented.localTime,
    timeZone: model.timeZone,
    gstReference: presented.gstReference,
  };
  const identity = { companyName: companyName(), supportEmail: supportEmail() };
  const person = { firstName: model.firstName };
  const reference = bookingReference(model.bookingId);
  const rights = {
    reference,
    withdrawUrl: `${clientEnv.NEXT_PUBLIC_SITE_URL}${TRAINING_BASE}/book/withdraw?ref=${reference}`,
    termsUrl: POLICY_LINKS.terms,
    policyUrl: POLICY_LINKS.bookingAndRefunds,
    cancellationDays: BOOKING_POLICY.cancellationDays,
    moveNoticeHours: BOOKING_POLICY.moveNoticeHours,
  };

  /*
    A confirmation or a reminder with nowhere to click is worse than none: the
    customer stops waiting for the real one. Refused here rather than rendered
    with a blank, so the queue records a failure somebody can see.
  */
  const joinUrl = (): string => {
    if (!model.joinUrl) {
      throw new TemplateNotAvailableError(templateKey, "no joining link exists for this booking");
    }
    return model.joinUrl;
  };

  switch (templateKey) {
    case "payment_receipt":
      return rendered(
        paymentReceivedSubject(details),
        <PaymentReceivedEmail
          {...details}
          {...identity}
          {...person}
          rights={rights}
          agreement={
            model.agreement
              ? { ...model.agreement, amountPaid: formatAed(model.agreement.amountPaidFils) }
              : null
          }
        />,
      );

    case "booking_confirmation":
      return rendered(
        bookingConfirmationSubject(details),
        <BookingConfirmationEmail
          {...details}
          {...identity}
          {...person}
          rights={rights}
          joinUrl={joinUrl()}
          durationMinutes={model.durationMinutes}
        />,
      );

    case "reminder_24h":
    case "reminder_3h": {
      const hoursBefore = templateKey === "reminder_24h" ? 24 : 3;
      return rendered(
        reminderSubject({ ...details, hoursBefore }),
        <ReminderEmail
          {...details}
          {...identity}
          {...person}
          joinUrl={joinUrl()}
          hoursBefore={hoursBefore}
        />,
      );
    }

    case "follow_up":
      return rendered(
        followUpSubject(details),
        <FollowUpEmail
          {...identity}
          {...person}
          sessionTitle={model.sessionTitle}
          nextSessionTitle={model.nextSessionTitle}
        />,
      );

    default:
      throw new TemplateNotAvailableError(templateKey, "no template exists for it yet");
  }
}

/** What the withdrawal acknowledgement states. Not a session email: a booking may have no time yet. */
export interface WithdrawalEmailModel {
  readonly firstName: string;
  readonly sessionTitle: string;
  readonly reference: string;
  readonly statement: string;
  readonly receivedAt: Date;
  /** The customer's zone, as captured at booking. */
  readonly timeZone: string;
  readonly refundDueFils: Fils;
}

export async function renderWithdrawalAcknowledgement(
  model: WithdrawalEmailModel,
): Promise<RenderedEmail> {
  return rendered(
    withdrawalAcknowledgementSubject(model),
    <WithdrawalAcknowledgementEmail
      firstName={model.firstName}
      sessionTitle={model.sessionTitle}
      reference={model.reference}
      statement={model.statement}
      receivedLabel={describeInstant(model.receivedAt, model.timeZone)}
      refundLabel={formatAed(model.refundDueFils)}
      refundDays={BOOKING_POLICY.withdrawalRefundDays}
      companyName={companyName()}
      supportEmail={supportEmail()}
    />,
  );
}

async function rendered(subject: string, element: React.ReactElement): Promise<RenderedEmail> {
  const html = await render(element);
  const text = await render(element, { plainText: true });
  return { subject, html, text };
}
