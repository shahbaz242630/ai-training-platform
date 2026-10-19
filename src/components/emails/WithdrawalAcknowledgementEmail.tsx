import { REFUND_CURRENCY_NOTE } from "@/config/site";
import { EmailLayout, emailStyles } from "./EmailLayout";

/**
 * The acknowledgement of a customer's notice of withdrawal.
 *
 * UK and EU law asks for it on a durable medium (an email is one) without
 * delay, so it is queued in the same transaction that keeps the notice. It
 * repeats the notice word for word, says when it was received, and states
 * the refund due and where it stands, so the customer holds their own record
 * of all three.
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
  /** Working days the desk takes to answer a notice it decides. */
  readonly deskReplyDays: number;
  readonly refund: WithdrawalRefundState;
  readonly companyName: string;
  readonly supportEmail: string;
}

/**
 * Where the refund stands when the email goes. "Refunded" only once Stripe
 * says it succeeded: a refund still on its way can fail (a closed card), and
 * a durable record should not say something that may turn out untrue.
 * "Review": the card is not from the UK or the EU, so a person decides and
 * the booking stays in place meanwhile; nothing is promised but the answer.
 */
export type WithdrawalRefundState = "succeeded" | "issued" | "owed" | "review";

/** What the customer's bank does after that is not ours to promise, so it is said as usual, not as a promise. */
const BANK_TIMING =
  "Banks usually take 5 to 10 working days to show it on your statement. If it has not appeared " +
  "after 10 working days, reply to this email and we will look into it.";

function refundSentence(props: WithdrawalAcknowledgementEmailProps): string {
  switch (props.refund) {
    case "succeeded":
      return (
        `Your booking is cancelled. We have refunded ${props.refundLabel} to the card you paid ` +
        `with, at no cost to you. ${BANK_TIMING}`
      );
    case "issued":
      return (
        `Your booking is cancelled. We have issued a full refund of ${props.refundLabel} to the ` +
        `card you paid with, at no cost to you. ${BANK_TIMING}`
      );
    case "owed":
      return (
        `Your booking is cancelled. We will refund ${props.refundLabel} to the card you paid with ` +
        `within ${props.refundDays} days, at no cost to you, and email you when the refund has been issued.`
      );
    case "review":
      return (
        "We could not confirm automatically that the UK and EU 14-day right applies to this " +
        "booking, so a member of our team will look at it and reply by email within " +
        `${props.deskReplyDays} working days. Your booking stays in place until then. If the ` +
        `right applies, we refund ${props.refundLabel} in full, to the card you paid with, within ` +
        `${props.refundDays} days of your notice.`
      );
  }
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
          <strong>Refund:</strong>{" "}
          {props.refund === "review" ? "Being reviewed" : props.refundLabel}
        </p>
      </div>
      <p style={emailStyles.paragraph}>{refundSentence(props)}</p>
      <p style={emailStyles.paragraph}>{REFUND_CURRENCY_NOTE}</p>
      <p style={emailStyles.muted}>
        If you did not send this, reply to this email straight away and we will look into it.
      </p>
    </EmailLayout>
  );
}
