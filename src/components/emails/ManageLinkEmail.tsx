import { EmailLayout, emailStyles } from "./EmailLayout";

/**
 * Sent when somebody asks "Manage my booking" for this address. It lists the
 * upcoming bookings with a fresh link each; the links work for one hour. Only
 * the owner of the inbox ever sees it, which is what makes the links safe.
 */
export interface ManageLinkEmailProps {
  readonly firstName: string;
  readonly bookings: ReadonlyArray<{
    readonly sessionTitle: string;
    /** e.g. "Thursday, 10 September 2026 at 19:00 (Asia/Dubai)". */
    readonly when: string;
    readonly reference: string;
    readonly manageUrl: string;
  }>;
  readonly linkMinutes: number;
  readonly companyName: string;
  readonly supportEmail: string;
}

export function manageLinkSubject() {
  return "Manage your booking";
}

export function ManageLinkEmail(props: ManageLinkEmailProps) {
  return (
    <EmailLayout
      preview="Your link to manage your booking. It works for one hour."
      companyName={props.companyName}
      supportEmail={props.supportEmail}
    >
      <h1 style={emailStyles.heading}>Manage your booking, {props.firstName}.</h1>
      <p style={emailStyles.paragraph}>
        You asked for a link to manage your booking. Each link below works for {props.linkMinutes}{" "}
        minutes.
      </p>
      {props.bookings.map((booking) => (
        <div key={booking.reference} style={{ margin: "0 0 20px" }}>
          <p style={emailStyles.detail}>
            <strong>{booking.sessionTitle}</strong>
          </p>
          <p style={emailStyles.detail}>{booking.when}</p>
          <p style={emailStyles.detail}>Booking reference: {booking.reference}</p>
          <p style={{ ...emailStyles.paragraph, margin: "10px 0 0" }}>
            <a href={booking.manageUrl} style={emailStyles.button}>
              Manage this booking
            </a>
          </p>
        </div>
      ))}
      <p style={emailStyles.muted}>
        If you did not ask for this, you can ignore this email. Nothing changes unless a link is
        used.
      </p>
    </EmailLayout>
  );
}
