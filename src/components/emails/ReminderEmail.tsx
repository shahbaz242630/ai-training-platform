import { EmailLayout, SessionDetails, emailStyles, type SessionDetailsProps } from "./EmailLayout";

/**
 * The 24-hour and 3-hour reminders. One template, because they say the same
 * thing at different distances - and a customer who reads both should
 * recognise the second as the same message, not a new one.
 */
export interface ReminderEmailProps extends SessionDetailsProps {
  readonly firstName: string;
  readonly joinUrl: string;
  readonly hoursBefore: 24 | 3;
  readonly companyName: string;
  readonly supportEmail: string;
}

export function reminderSubject(
  props: Pick<ReminderEmailProps, "sessionTitle" | "localTime" | "hoursBefore">,
) {
  const when = props.hoursBefore === 24 ? "Tomorrow" : "In three hours";
  return `${when}: ${props.sessionTitle} at ${props.localTime}`;
}

export function ReminderEmail(props: ReminderEmailProps) {
  const soon = props.hoursBefore === 3;
  return (
    <EmailLayout
      preview={
        soon
          ? `Your session starts in about three hours. The joining link is inside.`
          : `Your session is tomorrow at ${props.localTime}. The joining link is inside.`
      }
      companyName={props.companyName}
      supportEmail={props.supportEmail}
    >
      <h1 style={emailStyles.heading}>
        {soon ? "Starting in about three hours" : "Your session is tomorrow"}, {props.firstName}.
      </h1>
      <SessionDetails {...props} />
      <p style={emailStyles.paragraph}>
        <a href={props.joinUrl} style={emailStyles.button}>
          Join the session
        </a>
      </p>
      <p style={emailStyles.paragraph}>
        {soon
          ? "If the link does not open for you, reply to this email straight away and we will send another way in."
          : "Have your tools open and one real task ready. If something has come up, reply now and we will find another time."}
      </p>
    </EmailLayout>
  );
}
