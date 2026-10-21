import {
  BookingRights,
  EmailLayout,
  SessionDetails,
  emailStyles,
  type BookingRightsProps,
  type SessionDetailsProps,
} from "./EmailLayout";

/**
 * Sent the moment a payment settles, before the joining link exists.
 *
 * This is the email that ends "a customer who paid today would receive
 * nothing". It promises only what settlement has actually done - taken the
 * payment and reserved the time - and says plainly that the joining details
 * follow, with a way to ask if they do not.
 */
export interface PaymentReceivedEmailProps extends SessionDetailsProps {
  readonly rights: BookingRightsProps;
  readonly firstName: string;
  /** What was paid and agreed, as stored when they agreed. Null only if no record exists. */
  readonly agreement: AgreementDetails | null;
  readonly companyName: string;
  readonly supportEmail: string;
}

/** The contract as the customer agreed it: the stored words, never re-derived from today's copy. */
export interface AgreementDetails {
  /** e.g. "AED 1,499" */
  readonly amountPaid: string;
  readonly termsVersion: string;
  readonly keyTerms: readonly string[];
  /** The 14-day express request, when the session fell inside the period. */
  readonly expressRequestText: string | null;
}

export function paymentReceivedSubject(
  props: Pick<PaymentReceivedEmailProps, "sessionTitle" | "dayLabel">,
) {
  return `Payment received: ${props.sessionTitle}, ${props.dayLabel}`;
}

/**
 * The same acknowledgement for a payment that reached us after the time it
 * was for had gone back on sale. The contract is still confirmed in writing,
 * with the terms attached, before anything else happens; the link to choose a
 * new time follows in its own email.
 */
export interface PaymentReceivedNoTimeProps {
  readonly sessionTitle: string;
  readonly rights: BookingRightsProps;
  readonly firstName: string;
  readonly agreement: AgreementDetails | null;
  readonly companyName: string;
  readonly supportEmail: string;
}

export function paymentReceivedNoTimeSubject(
  props: Pick<PaymentReceivedNoTimeProps, "sessionTitle">,
) {
  return `Payment received: ${props.sessionTitle}`;
}

export function PaymentReceivedNoTimeEmail(props: PaymentReceivedNoTimeProps) {
  return (
    <EmailLayout
      preview="We have your payment. Your session needs a new time."
      companyName={props.companyName}
      supportEmail={props.supportEmail}
    >
      <h1 style={emailStyles.heading}>Thank you, {props.firstName}. Your payment is in.</h1>
      <p style={emailStyles.paragraph}>
        We have received your payment. The time you chose was no longer free by the time your
        payment reached us, so your session does not have a time yet. We are sorry about that.
      </p>
      <div style={{ margin: "0 0 20px" }}>
        <p style={emailStyles.detail}>
          <strong>Session:</strong> {props.sessionTitle}
        </p>
        <p style={emailStyles.detail}>
          <strong>Time:</strong> to be chosen
        </p>
      </div>
      {props.agreement ? <Agreement {...props.agreement} /> : null}
      {props.agreement ? (
        <p style={emailStyles.muted}>
          The full Coaching Terms and Booking and Refund Policy you agreed to are attached as a PDF,
          so you keep them exactly as they were when you booked.
        </p>
      ) : null}
      <p style={emailStyles.paragraph}>
        We will email you a link to choose any open time. If you would rather have your money back,
        reply to this email and we will refund you in full.
      </p>
      <BookingRights {...props.rights} />
    </EmailLayout>
  );
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
      {props.agreement ? <Agreement {...props.agreement} /> : null}
      {props.agreement ? (
        <p style={emailStyles.muted}>
          The full Coaching Terms and Booking and Refund Policy you agreed to are attached as a PDF,
          so you keep them exactly as they were when you booked.
        </p>
      ) : null}
      <p style={emailStyles.paragraph}>
        Your confirmation, with the link to join and a file to add the session to your calendar,
        will follow by email. If it has not arrived within an hour, reply to this message and we
        will sort it out.
      </p>
      <p style={emailStyles.muted}>
        Times are shown in your own time zone. We are in Dubai, Gulf Standard Time, four hours ahead
        of UTC all year.
      </p>
      <p style={emailStyles.muted}>
        If something goes wrong, reply to this email before you ask your bank to reverse the
        payment. We answer within 2 working days.
      </p>
      <BookingRights {...props.rights} />
    </EmailLayout>
  );
}

function Agreement(props: AgreementDetails) {
  return (
    <div style={{ margin: "0 0 20px" }}>
      <p style={emailStyles.detail}>
        <strong>Paid:</strong> {props.amountPaid}
      </p>
      <p style={{ ...emailStyles.detail, margin: "14px 0 6px" }}>
        <strong>What you agreed to</strong> (terms version {props.termsVersion}):
      </p>
      <ul style={{ margin: "0 0 12px", paddingLeft: "20px" }}>
        {props.keyTerms.map((line) => (
          <li key={line} style={emailStyles.detail}>
            {line}
          </li>
        ))}
      </ul>
      {props.expressRequestText ? (
        <p style={emailStyles.detail}>
          <strong>You also asked:</strong> {props.expressRequestText}
        </p>
      ) : null}
    </div>
  );
}
