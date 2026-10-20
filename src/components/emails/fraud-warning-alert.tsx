import { render } from "@react-email/render";
import { companyName, supportEmail } from "@/config/site";
import { getSessionBySlug } from "@/config/sessions";
import type { FraudWarningForDesk } from "@/data/fraud-warnings";
import { bookingReference } from "@/domain/booking/withdrawal";
import { formatAed } from "@/lib/money";
import { dubaiTime } from "./desk-alerts";
import { EmailLayout, emailStyles } from "./EmailLayout";
import type { RenderedEmail } from "./templates";

/**
 * The desk alert for an early fraud warning (audit s104 PAY-4): the card
 * network saying a payment was probably made with a stolen card. Internal and
 * plain, ids and facts only, like every desk alert.
 */

function reference(warning: FraudWarningForDesk): string {
  return warning.bookingId === null ? "unknown" : bookingReference(warning.bookingId);
}

function amount(warning: FraudWarningForDesk): string {
  return warning.grossAmountFils === null ? "amount unknown" : formatAed(warning.grossAmountFils);
}

export function fraudWarningSubject(warning: FraudWarningForDesk, reminder: boolean): string {
  const base =
    warning.outcome === "refund_queued"
      ? `Stolen card warning, refunded automatically: booking ${reference(warning)}, ${amount(warning)}`
      : `Stolen card warning, needs you: booking ${reference(warning)}, ${amount(warning)}`;
  return reminder ? `Reminder: ${base}` : base;
}

function whatHappened(warning: FraudWarningForDesk): string {
  const card = `The card network has warned (${warning.fraudType.replaceAll("_", " ")}) that the payment for this booking was probably made with a stolen card. A chargeback usually follows within weeks.`;
  switch (warning.outcome) {
    case "refund_queued":
      return `${card} The session was more than two hours away, so it has been cancelled and the full amount is being refunded to the card. Nobody was emailed: the person who booked may not be the cardholder.`;
    case "unknown_order":
      return `${card} No booking of ours has this payment, so nothing was done.`;
    default:
      return `${card} Nothing was done automatically, because the session is less than two hours away, already took place, or the payment is not in a state to refund in full.`;
  }
}

function toDo(warning: FraudWarningForDesk): string {
  switch (warning.outcome) {
    case "refund_queued":
      return "Nothing, unless a refund alarm follows. The customer cannot move or rebook this session online. If they contact us, do not rebook them by hand without checking who they are.";
    case "unknown_order":
      return "Look up the payment in Stripe, Payments. If it is ours, refund it in full there.";
    default:
      return "Decide in Stripe, Payments: refunding in full now usually prevents the chargeback and its fee. A full refund there cancels any session still to come. Do not deliver a session to someone you cannot verify.";
  }
}

function FraudWarningEmail(props: {
  readonly warning: FraudWarningForDesk;
  readonly reminder: boolean;
  readonly companyName: string;
  readonly supportEmail: string;
}) {
  const { warning } = props;
  const what = whatHappened(warning);
  const session = warning.sessionSlug === null ? null : getSessionBySlug(warning.sessionSlug);
  return (
    <EmailLayout preview={what} companyName={props.companyName} supportEmail={props.supportEmail}>
      <h1 style={emailStyles.heading}>
        {props.reminder ? "Still needs you: stolen card warning" : "Stolen card warning"}
      </h1>
      <p style={emailStyles.paragraph}>{what}</p>
      <p style={emailStyles.paragraph}>To do: {toDo(warning)}</p>
      <p style={emailStyles.muted}>
        Booking {reference(warning)}
        {session ? `, ${session.title}` : ""}
        {warning.sessionStart ? `, ${dubaiTime(warning.sessionStart)}` : ""}. Amount{" "}
        {amount(warning)}. Warning received {dubaiTime(warning.receivedAt)}.
      </p>
    </EmailLayout>
  );
}

export async function renderFraudWarning(
  warning: FraudWarningForDesk,
  reminder: boolean,
): Promise<RenderedEmail> {
  const element = (
    <FraudWarningEmail
      warning={warning}
      reminder={reminder}
      companyName={companyName()}
      supportEmail={supportEmail()}
    />
  );
  return {
    subject: fraudWarningSubject(warning, reminder),
    html: await render(element),
    text: await render(element, { plainText: true }),
  };
}
