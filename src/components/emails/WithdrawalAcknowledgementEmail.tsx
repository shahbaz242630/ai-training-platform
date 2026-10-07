import { EmailLayout, emailStyles } from "./EmailLayout";

/**
 * The acknowledgement of a customer's notice of withdrawal.
 *
 * UK and EU law asks for it on a durable medium (an email is one) without
 * delay, so it is queued in the same transaction that keeps the notice. It
 * repeats the notice word for word, says when it was received, and states
 * the refund due and when it will arrive, so the customer holds their own
 * record of all three.
 */
export interface WithdrawalAcknowledgementEmailProps {
  readonly firstName: string;
  readonly sessionTitle: string;
  readonly reference: string;
  readonly statement: string;
  /** e.g. "Wednesday, 7 October 2026 at 10:05 (Europe/London) · 13:05 GST" */
  readonly receivedLabel: string;
  /** e.g. "AED 1,299" */
  readonly refundLabel: string;
  readonly refundDays: number;
  readonly companyName: string;
  readonly supportEmail: string;
}

export function withdrawalAcknowledgementSubject(
  props: Pick<WithdrawalAcknowledgementEmailProps, "reference">,
) {
  return `We have received your withdrawal (booking ${props.reference})`;
}

export function WithdrawalAcknowledgementEmail(props: WithdrawalAcknowledgementEmailProps) {
  return (
    <EmailLayout
      preview={`Your withdrawal from booking ${props.reference} was received on ${props.receivedLabel}.`}
      companyName={props.companyName}
      supportEmail={props.supportEmail}
    >
      <h1 style={emailStyles.heading}>{props.firstName}, we have received your withdrawal.</h1>
      <p style={emailStyles.paragraph}>
        This email confirms the notice you gave us. Please keep it for your records.
      </p>
      <div style={{ margin: "0 0 20px" }}>
        <p style={emailStyles.detail}>
          <strong>Your notice:</strong> {props.statement}
        </p>
        <p style={emailStyles.detail}>
          <strong>Received:</strong> {props.receivedLabel}
        </p>
        <p style={emailStyles.detail}>
          <strong>Session:</strong> {props.sessionTitle}
        </p>
        <p style={emailStyles.detail}>
          <strong>Booking reference:</strong> {props.reference}
        </p>
        <p style={emailStyles.detail}>
          <strong>Refund:</strong> {props.refundLabel}
        </p>
      </div>
      <p style={emailStyles.paragraph}>
        Your booking is cancelled. We will refund {props.refundLabel} to the card you paid with
        within {props.refundDays} days, at no cost to you.
      </p>
      <p style={emailStyles.muted}>
        If you did not send this, reply to this email straight away and we will look into it.
      </p>
    </EmailLayout>
  );
}
