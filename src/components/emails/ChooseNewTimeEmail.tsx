import { EmailLayout, emailStyles } from "./EmailLayout";

/**
 * A paid booking with no session time, and the customer's own link to choose
 * one (founder decision, October 2026: sent by itself, not forwarded by the
 * desk). The time was lost on our side: the payment arrived after the time
 * had gone back on sale, or the held time was taken off the calendar before
 * the booking was confirmed. Choosing a time this way is not a move, so the
 * customer's one free move is still theirs.
 *
 * Worded to fit both causes. The link is a bearer link, valid for a limited
 * number of days; the payment acknowledgement with the terms is its own email.
 */
export interface ChooseNewTimeEmailProps {
  readonly firstName: string;
  readonly sessionTitle: string;
  readonly reference: string;
  readonly chooseTimeUrl: string;
  readonly linkDays: number;
  readonly companyName: string;
  readonly supportEmail: string;
}

export function chooseNewTimeSubject(props: Pick<ChooseNewTimeEmailProps, "sessionTitle">) {
  return `Choose a time for your session: ${props.sessionTitle}`;
}

export function ChooseNewTimeEmail(props: ChooseNewTimeEmailProps) {
  return (
    <EmailLayout
      preview="Your session needs a time. Choose any open time from the link."
      companyName={props.companyName}
      supportEmail={props.supportEmail}
    >
      <h1 style={emailStyles.heading}>{props.firstName}, please choose a time for your session.</h1>
      <p style={emailStyles.paragraph}>
        Your payment for {props.sessionTitle} is confirmed, but the session does not have a time on
        our calendar. That is our doing, and we are sorry.
      </p>
      <p style={emailStyles.paragraph}>
        <a href={props.chooseTimeUrl} style={emailStyles.button}>
          Choose my session time
        </a>
      </p>
      <p style={emailStyles.paragraph}>
        You can pick any open time. The link works for {props.linkDays} days. Choosing a time this
        way does not use up your one free move, so you can still move the session once later if you
        need to.
      </p>
      <p style={emailStyles.paragraph}>
        If you would rather have your money back, reply to this email and we will refund you in
        full.
      </p>
      <p style={emailStyles.detail}>
        <strong>Booking reference:</strong> {props.reference}
      </p>
    </EmailLayout>
  );
}
