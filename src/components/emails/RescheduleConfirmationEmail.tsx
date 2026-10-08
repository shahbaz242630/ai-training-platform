import {
  BookingRights,
  EmailLayout,
  SessionDetails,
  emailStyles,
  type BookingRightsProps,
  type SessionDetailsProps,
} from "./EmailLayout";

/**
 * Sent when the customer has moved their session. It carries the new time,
 * the same joining link, and a calendar file that replaces the old entry.
 * Never rendered without a link, for the same reason as the confirmation.
 */
export interface RescheduleConfirmationEmailProps extends SessionDetailsProps {
  readonly rights: BookingRightsProps;
  readonly firstName: string;
  readonly joinUrl: string;
  readonly companyName: string;
  readonly supportEmail: string;
}

export function rescheduleConfirmationSubject(
  props: Pick<RescheduleConfirmationEmailProps, "sessionTitle" | "dayLabel" | "localTime">,
) {
  return `Moved: ${props.sessionTitle}, now ${props.dayLabel} at ${props.localTime}`;
}

export function RescheduleConfirmationEmail(props: RescheduleConfirmationEmailProps) {
  return (
    <EmailLayout
      preview={`Your session has moved to ${props.dayLabel}. The joining link is inside.`}
      companyName={props.companyName}
      supportEmail={props.supportEmail}
    >
      <h1 style={emailStyles.heading}>Your session has moved, {props.firstName}.</h1>
      <p style={emailStyles.paragraph}>Here is your new time.</p>
      <SessionDetails {...props} />
      <p style={emailStyles.paragraph}>
        <a href={props.joinUrl} style={emailStyles.button}>
          Join the session
        </a>
      </p>
      <p style={emailStyles.paragraph}>
        The joining link has not changed. Open the calendar file attached to this email to update
        your calendar; it replaces the old entry.
      </p>
      <p style={emailStyles.muted}>
        This was your one free move, so the new time is final. If you cannot attend, the session
        counts as used.
      </p>
      <BookingRights {...props.rights} manageUrl={null} moved />
    </EmailLayout>
  );
}
