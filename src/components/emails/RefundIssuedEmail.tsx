import { REFUND_CURRENCY_NOTE } from "@/config/site";
import { EmailLayout, emailStyles } from "./EmailLayout";

/**
 * Sent once a withdrawal's refund has gone to Stripe: the follow-up the
 * acknowledgement promised. What the customer's bank does after that is not
 * ours to promise, so it is said as usual, with what to do if it does not show.
 */
export interface RefundIssuedEmailProps {
  readonly firstName: string;
  readonly reference: string;
  /** e.g. "AED 1,299" */
  readonly refundLabel: string;
  readonly companyName: string;
  readonly supportEmail: string;
}

export function refundIssuedSubject(props: Pick<RefundIssuedEmailProps, "reference">) {
  return `Your refund has been issued (booking ${props.reference})`;
}

export function RefundIssuedEmail(props: RefundIssuedEmailProps) {
  return (
    <EmailLayout
      preview={`Your refund of ${props.refundLabel} has been issued.`}
      companyName={props.companyName}
      supportEmail={props.supportEmail}
    >
      <h1 style={emailStyles.heading}>Your refund has been issued.</h1>
      <p style={emailStyles.paragraph}>
        {props.firstName}, your refund of {props.refundLabel} has been issued to the card you paid
        with. Banks usually take 5 to 10 working days to show it on your statement. If it has not
        appeared after 10 working days, reply to this email and we will look into it.
      </p>
      <p style={emailStyles.paragraph}>{REFUND_CURRENCY_NOTE}</p>
      <p style={emailStyles.detail}>
        <strong>Booking reference:</strong> {props.reference}
      </p>
    </EmailLayout>
  );
}
