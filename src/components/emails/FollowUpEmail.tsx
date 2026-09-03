import { EmailLayout, emailStyles } from "./EmailLayout";

/**
 * Sent about an hour after the session ends.
 *
 * It asks for nothing that would make the customer feel sold to. A next
 * session is mentioned only when the catalogue has one that follows on, and
 * as a fact rather than an offer. Testimonials are not requested here: that
 * is a conversation, not a template.
 */
export interface FollowUpEmailProps {
  readonly firstName: string;
  readonly sessionTitle: string;
  readonly nextSessionTitle: string | null;
  readonly companyName: string;
  readonly supportEmail: string;
}

export function followUpSubject(props: Pick<FollowUpEmailProps, "sessionTitle">) {
  return `After your session: ${props.sessionTitle}`;
}

export function FollowUpEmail(props: FollowUpEmailProps) {
  return (
    <EmailLayout
      preview="Thank you for today. A few things to do while it is fresh."
      companyName={props.companyName}
      supportEmail={props.supportEmail}
    >
      <h1 style={emailStyles.heading}>Thank you for today, {props.firstName}.</h1>
      <p style={emailStyles.paragraph}>
        The most useful thing you can do now is use what we covered on a real piece of your own work
        in the next day or two, while it is fresh. If you get stuck on something we touched on,
        reply to this email and describe where it stopped working.
      </p>
      {props.nextSessionTitle ? (
        <p style={emailStyles.paragraph}>
          When you are ready to go further, the session that follows on from this one is{" "}
          <strong>{props.nextSessionTitle}</strong>. You can book it from the same page you booked
          today from.
        </p>
      ) : null}
      <p style={emailStyles.muted}>
        If today was useful, we would genuinely like to hear what you built. A reply is enough.
      </p>
    </EmailLayout>
  );
}
