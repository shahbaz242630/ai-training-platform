import { REFUND_CURRENCY_NOTE } from "@/config/site";
import { EmailLayout, emailStyles } from "./EmailLayout";

/**
 * Sent when a full refund cancels a booking: most often the desk approving a
 * withdrawal by refunding in the payment dashboard, or any other full refund
 * made there. Without it the customer would see their calendar invitation
 * disappear and hear nothing from us, so it says plainly what happened: the
 * booking is cancelled, and the money is on its way back.
 */
export interface CancellationConfirmationEmailProps {
  readonly firstName: string;
  readonly sessionTitle: string;
  readonly reference: string;
  /** e.g. "Friday, 20 November 2026, 15:00 (Europe/London)"; null when no time was arranged. */
  readonly sessionTime: string | null;
  /** e.g. "AED 1,299" */
  readonly refundLabel: string;
  readonly companyName: string;
  readonly supportEmail: string;
}

export function cancellationConfirmationSubject(
  props: Pick<CancellationConfirmationEmailProps, "reference">,
) {
  return `Your booking is cancelled and refunded (booking ${props.reference})`;
}

export function CancellationConfirmationEmail(props: CancellationConfirmationEmailProps) {
  return (
    <EmailLayout
      preview={`Your booking ${props.reference} is cancelled and ${props.refundLabel} has been refunded.`}
      companyName={props.companyName}
      supportEmail={props.supportEmail}
    >
      <h1 style={emailStyles.heading}>{props.firstName}, your booking is cancelled.</h1>
      <p style={emailStyles.paragraph}>
        We have cancelled your booking and refunded {props.refundLabel} in full to the card you paid
        with.{" "}
        {props.sessionTime
          ? "The calendar invitation for the session is withdrawn, and you will not receive any more reminders for it."
          : "You will not receive any more emails about this session."}
      </p>
      <div style={{ margin: "0 0 20px" }}>
        <p style={emailStyles.detail}>
          <strong>Session:</strong> {props.sessionTitle}
        </p>
        {props.sessionTime ? (
          <p style={emailStyles.detail}>
            <strong>Was booked for:</strong> {props.sessionTime}
          </p>
        ) : null}
        <p style={emailStyles.detail}>
          <strong>Booking reference:</strong> {props.reference}
        </p>
        <p style={emailStyles.detail}>
          <strong>Refunded:</strong> {props.refundLabel}
        </p>
      </div>
      <p style={emailStyles.paragraph}>
        Banks usually take 5 to 10 working days to show a refund on your statement. If it has not
        appeared after 10 working days, reply to this email and we will look into it.
      </p>
      <p style={emailStyles.paragraph}>{REFUND_CURRENCY_NOTE}</p>
      <p style={emailStyles.muted}>
        If you did not expect this, reply to this email and we will look into it straight away.
      </p>
    </EmailLayout>
  );
}
