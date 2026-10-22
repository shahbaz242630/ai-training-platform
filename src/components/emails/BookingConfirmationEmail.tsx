import {
  BookingRights,
  EmailLayout,
  SessionDetails,
  emailStyles,
  type BookingRightsProps,
  type SessionDetailsProps,
} from "./EmailLayout";

/**
 * Sent once the session exists in the calendar with a joining link.
 *
 * It is never rendered without a link: a confirmation with nowhere to click
 * is worse than no confirmation, because the customer stops waiting for one.
 */
export interface BookingConfirmationEmailProps extends SessionDetailsProps {
  readonly rights: BookingRightsProps;
  readonly firstName: string;
  readonly joinUrl: string;
  readonly durationMinutes: number;
  readonly companyName: string;
  readonly supportEmail: string;
  /**
   * The link that confirms the occasional emails about new sessions the
   * customer asked for. Only while a request is on record and unconfirmed.
   */
  readonly confirmEmailsUrl?: string | null;
}

export function bookingConfirmationSubject(
  props: Pick<BookingConfirmationEmailProps, "sessionTitle" | "dayLabel" | "localTime">,
) {
  return `Booked: ${props.sessionTitle}, ${props.dayLabel} at ${props.localTime}`;
}

export function BookingConfirmationEmail(props: BookingConfirmationEmailProps) {
  return (
    <EmailLayout
      preview={`Your session is booked for ${props.dayLabel}. The joining link is inside.`}
      companyName={props.companyName}
      supportEmail={props.supportEmail}
    >
      <h1 style={emailStyles.heading}>Your session is booked, {props.firstName}.</h1>
      <SessionDetails {...props} />
      <p style={emailStyles.paragraph}>
        <a href={props.joinUrl} style={emailStyles.button}>
          Join the session
        </a>
      </p>
      <p style={emailStyles.paragraph}>
        Open the calendar file attached to this email to add the session, with this link, to your
        calendar. It is a one-to-one video call lasting {props.durationMinutes} minutes.
      </p>
      <h2 style={{ ...emailStyles.heading, fontSize: "17px", margin: "24px 0 8px" }}>
        Before we start
      </h2>
      <p style={emailStyles.paragraph}>
        Have the tools you want to work with open and signed in, and bring one real task from your
        own work. We will spend the time on that, not on slides.
      </p>
      {/*
        BookingRights below states the one free move, with the reschedule link
        when there is one, or says the time is final once the move is used.
        Only a confirmation without a link adds how to ask for the move.
      */}
      {props.rights.moved || props.rights.manageUrl ? null : (
        <p style={emailStyles.muted}>
          Need a different time? You can move your session once, free, at least{" "}
          {props.rights.moveNoticeHours} hours before it starts: reply to this email.
        </p>
      )}
      <BookingRights {...props.rights} />
      {props.confirmEmailsUrl ? (
        <p style={emailStyles.muted}>
          You asked to hear from us occasionally about new sessions.{" "}
          <a href={props.confirmEmailsUrl}>Confirm that this is your email address</a>. Until you
          do, we send you nothing but emails about this booking.
        </p>
      ) : null}
    </EmailLayout>
  );
}
