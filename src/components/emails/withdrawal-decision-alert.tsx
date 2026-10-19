import { render } from "@react-email/render";
import { BOOKING_POLICY, companyName, supportEmail } from "@/config/site";
import { getSessionBySlug } from "@/config/sessions";
import type { WithdrawalForDesk } from "@/data/withdrawals";
import { bookingReference } from "@/domain/booking/withdrawal";
import { describeInstant } from "@/domain/scheduling/slot-presentation";
import { formatAed } from "@/lib/money";
import { GST_TIMEZONE } from "@/lib/time";
import { EmailLayout, emailStyles } from "./EmailLayout";
import type { RenderedEmail } from "./templates";

/**
 * The desk alert for a withdrawal a person must decide: the customer ticked
 * that they are a UK or EU consumer, and the card they paid with says
 * otherwise (or its country could not be read). Nothing has been refunded and
 * the booking is still in place.
 *
 * Internal and plain, like every desk alert: the booking reference, the
 * amount, the payment id and the card's country, and no name or email
 * address. The customer's acknowledgement already reached this inbox as a
 * blind copy, and the payment in Stripe holds the rest.
 */

const DAY_MS = 24 * 60 * 60_000;

function cardLabel(alert: WithdrawalForDesk): string {
  return alert.cardCountry ?? "could not be read";
}

export function withdrawalDecisionSubject(alert: WithdrawalForDesk, reminder: boolean): string {
  const base =
    `Withdrawal to decide: booking ${bookingReference(alert.bookingId)}, ` +
    `${formatAed(alert.amountFils)}, card ${cardLabel(alert)}`;
  return reminder ? `Reminder: ${base}` : base;
}

interface WithdrawalDecisionEmailProps {
  readonly alert: WithdrawalForDesk;
  readonly reminder: boolean;
  /** The signed link that records a decline; null when no signing secret is set. */
  readonly declineUrl: string | null;
  readonly companyName: string;
  readonly supportEmail: string;
}

function WithdrawalDecisionEmail({
  alert,
  reminder,
  declineUrl,
  ...layout
}: WithdrawalDecisionEmailProps) {
  const session = getSessionBySlug(alert.sessionSlug)?.title ?? "a session";
  const card =
    alert.cardCountry === null
      ? "The country of the card they paid with could not be read."
      : `The card they paid with was issued in ${alert.cardCountry}.`;
  const what =
    `A customer has sent a withdrawal notice for ${session}, ticking that they are a UK or EU ` +
    `consumer. ${card} A card says where it was issued, not where its holder lives, so decide ` +
    `on what you know of the customer. Nothing has been refunded and the booking is still in ` +
    `place. They were told we would reply within ${BOOKING_POLICY.deskReplyWorkingDays} working days.`;
  const heading = "A withdrawal needs your decision";
  const decideBy = new Date(
    alert.receivedAt.getTime() + BOOKING_POLICY.withdrawalRefundDays * DAY_MS,
  );
  return (
    <EmailLayout preview={what} {...layout}>
      <h1 style={emailStyles.heading}>
        {reminder ? `Still needs you: ${heading.toLowerCase()}` : heading}
      </h1>
      <p style={emailStyles.paragraph}>{what}</p>
      <div style={{ margin: "0 0 20px" }}>
        <p style={emailStyles.detail}>
          <strong>Booking reference:</strong> {bookingReference(alert.bookingId)}
        </p>
        <p style={emailStyles.detail}>
          <strong>Session time:</strong>{" "}
          {alert.scheduledStart === null
            ? "not arranged yet"
            : describeInstant(alert.scheduledStart, GST_TIMEZONE)}
        </p>
        <p style={emailStyles.detail}>
          <strong>Notice received:</strong> {describeInstant(alert.receivedAt, GST_TIMEZONE)}
        </p>
        <p style={emailStyles.detail}>
          <strong>Card country:</strong> {cardLabel(alert)}
        </p>
        <p style={emailStyles.detail}>
          <strong>Amount:</strong> {formatAed(alert.amountFils)}
        </p>
        <p style={emailStyles.detail}>
          <strong>Payment id:</strong> {alert.paymentIntentId ?? "no payment on record"}
        </p>
        <p style={emailStyles.detail}>
          <strong>Refund due by, if approved:</strong> {describeInstant(decideBy, GST_TIMEZONE)}
        </p>
      </div>
      <p style={emailStyles.paragraph}>
        To approve (they do live in the UK or the EU): refund the payment in full in Stripe. The
        booking then cancels itself, its time goes back on sale, its reminders stop, and the
        customer is emailed that it is cancelled and refunded, with a copy to this inbox. If the
        session has already taken place, a refund does not cancel it: write to the customer
        yourself.
      </p>
      <p style={emailStyles.paragraph}>
        To decline: write to the customer from the knowledgecentre@ inbox. Explain that the 14-day
        right is for consumers who live in the UK or the EU, and that their booking stands, with its
        one free move from the Reschedule link. Do nothing in Stripe.
        {declineUrl ? " Then record the decline here, which stops this alert:" : ""}
      </p>
      {declineUrl ? (
        <p style={emailStyles.detail}>
          <a href={declineUrl}>{declineUrl}</a>
        </p>
      ) : null}
      <p style={emailStyles.muted}>
        This alert comes back once a day until the payment is refunded in full, the decline is
        recorded, the booking is cancelled, or {BOOKING_POLICY.deskDecisionDays} days have passed
        since the notice. Each reminder carries a fresh link.
      </p>
    </EmailLayout>
  );
}

export async function renderWithdrawalDecision(
  alert: WithdrawalForDesk,
  reminder: boolean,
  declineUrl: string | null,
): Promise<RenderedEmail> {
  const element = (
    <WithdrawalDecisionEmail
      alert={alert}
      reminder={reminder}
      declineUrl={declineUrl}
      companyName={companyName()}
      supportEmail={supportEmail()}
    />
  );
  return {
    subject: withdrawalDecisionSubject(alert, reminder),
    html: await render(element),
    text: await render(element, { plainText: true }),
  };
}
