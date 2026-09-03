import type { CSSProperties, ReactNode } from "react";

/**
 * The frame every customer email sits in.
 *
 * Plain elements with inline styles and a table for the outer layout, because
 * that is what email clients reliably render - no stylesheet, no flexbox, no
 * web fonts. The component library that used to wrap this is no longer
 * supported upstream, and a dependency nobody maintains has no place in the
 * path that tells a customer when their session is.
 *
 * Nothing here is clever on purpose. An email that renders slightly plainly
 * everywhere beats one that renders beautifully in three clients and blank in
 * the fourth.
 */

export interface EmailLayoutProps {
  /** Shown by inbox previews next to the subject. Hidden in the body itself. */
  readonly preview: string;
  readonly companyName: string;
  readonly supportEmail: string;
  readonly children: ReactNode;
}

const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export const emailStyles = {
  body: { margin: 0, padding: 0, backgroundColor: "#f4f4f2", fontFamily: FONT } as CSSProperties,
  outer: { width: "100%", backgroundColor: "#f4f4f2", padding: "24px 0" } as CSSProperties,
  card: {
    width: "100%",
    maxWidth: "600px",
    backgroundColor: "#ffffff",
    borderRadius: "8px",
    overflow: "hidden",
  } as CSSProperties,
  header: {
    padding: "20px 28px",
    fontSize: "15px",
    fontWeight: 600,
    color: "#1a1a1a",
    borderBottom: "1px solid #e6e6e2",
  } as CSSProperties,
  content: {
    padding: "28px",
    color: "#1a1a1a",
    fontSize: "16px",
    lineHeight: "24px",
  } as CSSProperties,
  heading: {
    margin: "0 0 16px",
    fontSize: "22px",
    lineHeight: "28px",
    fontWeight: 600,
  } as CSSProperties,
  paragraph: { margin: "0 0 16px" } as CSSProperties,
  muted: {
    margin: "0 0 16px",
    color: "#5c5c58",
    fontSize: "14px",
    lineHeight: "20px",
  } as CSSProperties,
  detail: { margin: "0 0 6px", fontSize: "15px", lineHeight: "22px" } as CSSProperties,
  button: {
    display: "inline-block",
    padding: "12px 20px",
    backgroundColor: "#1a1a1a",
    color: "#ffffff",
    textDecoration: "none",
    borderRadius: "6px",
    fontWeight: 600,
  } as CSSProperties,
  footer: {
    padding: "20px 28px",
    color: "#5c5c58",
    fontSize: "13px",
    lineHeight: "20px",
    borderTop: "1px solid #e6e6e2",
  } as CSSProperties,
  hidden: {
    display: "none",
    maxHeight: 0,
    overflow: "hidden",
    opacity: 0,
    color: "transparent",
  } as CSSProperties,
} as const;

export function EmailLayout({ preview, companyName, supportEmail, children }: EmailLayoutProps) {
  return (
    <html lang="en">
      {/* eslint-disable-next-line @next/next/no-head-element -- an email is its own document, not a page in this app */}
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width" />
        <title>{preview}</title>
      </head>
      <body style={emailStyles.body}>
        <div style={emailStyles.hidden} data-skip-in-text="true">
          {preview}
        </div>
        <table role="presentation" cellPadding={0} cellSpacing={0} style={emailStyles.outer}>
          <tbody>
            <tr>
              <td align="center">
                <table role="presentation" cellPadding={0} cellSpacing={0} style={emailStyles.card}>
                  <tbody>
                    <tr>
                      <td style={emailStyles.header}>{companyName}</td>
                    </tr>
                    <tr>
                      <td style={emailStyles.content}>{children}</td>
                    </tr>
                    <tr>
                      <td style={emailStyles.footer}>
                        Questions? Reply to this email, or write to {supportEmail}. This message is
                        about a session you booked with {companyName}.
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </html>
  );
}

/** The when-and-where block shared by every session email. */
export interface SessionDetailsProps {
  readonly sessionTitle: string;
  readonly dayLabel: string;
  readonly localTime: string;
  readonly timeZone: string;
  /** e.g. "22:00 GST" when the customer's clock differs from ours; null when it reads the same. */
  readonly gstReference: string | null;
  readonly joinUrl?: string | null;
}

export function SessionDetails({
  sessionTitle,
  dayLabel,
  localTime,
  timeZone,
  gstReference,
  joinUrl,
}: SessionDetailsProps) {
  /*
    Labelled lines rather than a table. A table reads well in HTML and comes
    out of the plain-text conversion with its cells run together; a line per
    fact reads correctly in both, and the plain-text version is the one a
    screen reader and some mail clients actually use.
  */
  return (
    <div style={{ margin: "0 0 20px" }}>
      <p style={emailStyles.detail}>
        <strong>Session:</strong> {sessionTitle}
      </p>
      <p style={emailStyles.detail}>
        <strong>Date:</strong> {dayLabel}
      </p>
      <p style={emailStyles.detail}>
        <strong>Time:</strong> {localTime} ({timeZone}){gstReference ? ` · ${gstReference}` : ""}
      </p>
      {joinUrl ? (
        <p style={emailStyles.detail}>
          <strong>Join:</strong> <a href={joinUrl}>{joinUrl}</a>
        </p>
      ) : null}
    </div>
  );
}
