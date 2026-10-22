import { EmailLayout, emailStyles } from "./EmailLayout";

/**
 * The two emails about the next session in the series: a month after a
 * session, then a month later, then nothing. They are marketing, sent only
 * on consent the address's owner confirmed, so each ends with the link that
 * stops them. Like the follow-up, the next session is stated as a fact, not
 * pressed: no discount, no deadline, no "spaces are limited".
 */
export interface NextSessionEmailProps {
  /** 1 a month after the session, 2 a month after that (the last). */
  readonly which: 1 | 2;
  readonly firstName: string;
  readonly sessionTitle: string;
  readonly nextSessionTitle: string;
  /** The catalogue's one-sentence summary of the next session. */
  readonly nextSessionSummary: string;
  readonly nextSessionUrl: string;
  readonly unsubscribeUrl: string;
  readonly companyName: string;
  readonly supportEmail: string;
}

export function nextSessionSubject(
  props: Pick<NextSessionEmailProps, "which" | "sessionTitle" | "nextSessionTitle">,
): string {
  return props.which === 1
    ? `Ready for the next step after ${props.sessionTitle}?`
    : `${props.nextSessionTitle} is there when you're ready`;
}

export function NextSessionEmail(props: NextSessionEmailProps) {
  const link = (
    <p style={emailStyles.paragraph}>
      <a href={props.nextSessionUrl} style={emailStyles.button}>
        See {props.nextSessionTitle}
      </a>
    </p>
  );
  return (
    <EmailLayout
      preview={nextSessionSubject(props)}
      companyName={props.companyName}
      supportEmail={props.supportEmail}
      unsubscribeUrl={props.unsubscribeUrl}
    >
      <p style={emailStyles.paragraph}>Hello {props.firstName}.</p>
      {props.which === 1 ? (
        <>
          <p style={emailStyles.paragraph}>
            It is a month since your {props.sessionTitle} session. If you have been using what we
            covered, the natural next step is <strong>{props.nextSessionTitle}</strong>.{" "}
            {props.nextSessionSummary}
          </p>
          <p style={emailStyles.paragraph}>You can book it here:</p>
          {link}
          <p style={emailStyles.muted}>If now is not the right time, no action is needed.</p>
        </>
      ) : (
        <>
          <p style={emailStyles.paragraph}>
            A last note from us about this: when you want to go further than {props.sessionTitle},{" "}
            <strong>{props.nextSessionTitle}</strong> picks up where it left off.
          </p>
          {link}
          <p style={emailStyles.muted}>We won&apos;t email you about it again.</p>
        </>
      )}
    </EmailLayout>
  );
}
