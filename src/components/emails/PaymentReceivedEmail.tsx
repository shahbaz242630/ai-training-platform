import { EmailLayout, SessionDetails, emailStyles, type SessionDetailsProps } from "./EmailLayout";

/**
 * Sent the moment a payment settles, before the calendar invitation exists.
 *
 * This is the email that ends "a customer who paid today would receive
 * nothing". It promises only what settlement has actually done - taken the
 * payment and reserved the time - and says plainly that the joining details
 * follow, with a way to ask if they do not.
 */
export interface PaymentReceivedEmailProps extends SessionDetailsProps {
  readonly firstName: string;
  readonly companyName: string;
  readonly supportEmail: string;
}

export function paymentReceivedSubject(
  props: Pick<PaymentReceivedEmailProps, "sessionTitle" | "dayLabel">,
) {
  return `Payment received: ${props.sessionTitle}, ${props.dayLabel}`;
}

export function PaymentReceivedEmail(props: PaymentReceivedEmailProps) {
  return (
    <EmailLayout
      preview={`We have your payment and your time is reserved for ${props.dayLabel}.`}
      companyName={props.companyName}
      supportEmail={props.supportEmail}
    >
      <h1 style={emailStyles.heading}>Thank you, {props.firstName}. Your payment is in.</h1>
      <p style={emailStyles.paragraph}>
        We have received your payment and reserved this time for your private session.
      </p>
      <SessionDetails {...props} joinUrl={null} />
      <p style={emailStyles.paragraph}>
        Your calendar invitation and the link to join will follow by email. If they have not arrived
        within one working day, reply to this message and we will sort it out.
      </p>
      <p style={emailStyles.muted}>
        Times are shown in your own time zone. We are in Dubai, Gulf Standard Time, four hours ahead
        of UTC all year.
      </p>
    </EmailLayout>
  );
}
