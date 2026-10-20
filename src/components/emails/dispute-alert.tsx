import { render } from "@react-email/render";
import { companyName, supportEmail } from "@/config/site";
import { getSessionBySlug } from "@/config/sessions";
import { deskStage, type DisputeForDesk } from "@/data/disputes";
import { bookingReference } from "@/domain/booking/withdrawal";
import { FRAUD_REASON } from "@/domain/payments/dispute-policy";
import { formatAed } from "@/lib/money";
import { dubaiTime } from "./desk-alerts";
import { EmailLayout, emailStyles } from "./EmailLayout";
import type { RenderedEmail } from "./templates";

/**
 * The desk alert for a dispute: a customer's bank reversing, or asking about,
 * a payment. Internal and plain, ids and facts only, like every desk alert.
 *
 * It exists because a missed deadline loses the dispute by itself, with the
 * fee, and a high dispute rate is what puts an account under the processor's
 * monitoring. So it says the deadline first, louder in the last two days, and
 * lists the evidence on record so answering takes minutes.
 */

/** Inside this, the subject says the deadline is close. */
const URGENT_MS = 48 * 60 * 60_000;

/** The amount in its own currency's minor unit: not every currency has two decimals. */
export function amountLabel(dispute: Pick<DisputeForDesk, "amountMinor" | "currency">): string {
  let digits = 2;
  try {
    digits =
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: dispute.currency,
      }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    // Not a currency code Intl knows: two decimals, as almost every currency has.
  }
  return `${dispute.currency} ${(dispute.amountMinor / 10 ** digits).toFixed(digits)}`;
}

function reference(dispute: DisputeForDesk): string {
  return dispute.bookingId === null ? "unknown" : bookingReference(dispute.bookingId);
}

export function disputeSubject(dispute: DisputeForDesk, reminder: boolean, now: Date): string {
  const urgent =
    dispute.evidenceDueBy !== null && dispute.evidenceDueBy.getTime() - now.getTime() < URGENT_MS;
  const stage = deskStage(dispute.status);
  const kind =
    dispute.kind === "outcome"
      ? stage === "won"
        ? "Dispute won, session was cancelled"
        : "Dispute lost"
      : stage === "inquiry"
        ? "Payment inquiry"
        : "Payment disputed";
  const base = `${kind}: booking ${reference(dispute)}, ${amountLabel(dispute)}`;
  if (dispute.kind === "outcome") return reminder ? `Reminder: ${base}` : base;
  if (urgent) return `URGENT, deadline in under 48 hours. ${base}`;
  return reminder ? `Reminder: ${base}` : base;
}

/** What to do, by what kind of dispute it is. */
function advice(dispute: DisputeForDesk): string {
  const stage = deskStage(dispute.status);
  if (stage === "won") {
    return (
      "The dispute is over and the money stays with us, but a session on this order was " +
      "cancelled because of it, so the customer has paid and has no session. Decide in Stripe: " +
      "if the booking was genuine, book a new time for them by hand and write to them from the " +
      "knowledgecentre@ inbox; if not, refund the payment in full. They cannot choose a time online."
    );
  }
  if (stage === "money_gone") {
    return (
      "The dispute is over and the bank has returned the money to the cardholder. Any session " +
      "still to come on this order has been cancelled and its time freed. The customer has not " +
      "been told by the app; write to them only if you judge it right. Do not refund as well."
    );
  }
  if (stage === "unknown") {
    return (
      `Stripe reports a status this app does not know yet ("${dispute.status}"). Open the ` +
      "dispute in Stripe and decide by hand. The customer cannot move the session meanwhile."
    );
  }
  if (stage === "inquiry") {
    return (
      "This is an inquiry: the bank is asking, no money has moved yet. Either answer it with the " +
      "evidence below, or refund the payment in full, which settles it with no dispute fee. " +
      "Left unanswered, it can turn into a chargeback."
    );
  }
  if (dispute.reason === FRAUD_REASON) {
    return (
      "The cardholder says they did not make this payment. A session still more than two hours " +
      "away has been cancelled and its time freed; one closer than that was left for you to " +
      "decide. Answer in Stripe with the evidence below, or accept the dispute if the booking " +
      "does look like a stolen card. While it is open, the app cancels any session on this " +
      "order again, so rebook only once Stripe shows the dispute as won."
    );
  }
  return (
    "The session has been left as booked, on purpose: a session that was there for the customer " +
    "is the evidence. Answer in Stripe with the evidence below. If the customer did not attend, " +
    "say so and attach the booking and reminder emails."
  );
}

function sessionLine(dispute: DisputeForDesk): string {
  const title =
    (dispute.sessionSlug === null ? undefined : getSessionBySlug(dispute.sessionSlug))?.title ??
    "unknown session";
  if (dispute.bookingStatus === null) return `${title}: no booking found for this payment`;
  if (dispute.bookingStatus === "cancelled") return `${title}: cancelled`;
  if (dispute.sessionStart === null) return `${title}: no time yet`;
  return `${title}: ${dubaiTime(dispute.sessionStart)} (${dispute.bookingStatus})`;
}

interface DisputeEmailProps {
  readonly dispute: DisputeForDesk;
  readonly reminder: boolean;
  readonly companyName: string;
  readonly supportEmail: string;
}

function DisputeEmail({ dispute, reminder, ...layout }: DisputeEmailProps) {
  const deadline =
    dispute.evidenceDueBy === null
      ? "no response is possible for this one (the card network allows none)"
      : dubaiTime(dispute.evidenceDueBy);
  const what =
    `A customer's bank has ${deskStage(dispute.status) === "inquiry" ? "asked about" : "disputed"} ` +
    `a payment of ${amountLabel(dispute)}. ` +
    (dispute.kind === "outcome"
      ? `The dispute has ended: ${deskStage(dispute.status) === "won" ? "won" : "lost"}.`
      : deskStage(dispute.status) === "inquiry"
        ? `Respond by ${deadline}, or it can turn into a chargeback.`
        : `Respond by ${deadline}, or the dispute is lost by itself.`);
  const heading =
    dispute.kind === "outcome"
      ? "A dispute has ended and needs a follow-up"
      : deskStage(dispute.status) === "inquiry"
        ? "A payment is being queried"
        : "A payment is disputed";
  return (
    <EmailLayout preview={what} {...layout}>
      <h1 style={emailStyles.heading}>
        {reminder ? `Still needs you: ${heading.toLowerCase()}` : heading}
      </h1>
      <p style={emailStyles.paragraph}>{what}</p>
      <div style={{ margin: "0 0 20px" }}>
        {dispute.kind === "respond" ? (
          <p style={emailStyles.detail}>
            <strong>Deadline:</strong> {deadline}
          </p>
        ) : null}
        <p style={emailStyles.detail}>
          <strong>Reason given:</strong> {dispute.reason}
        </p>
        <p style={emailStyles.detail}>
          <strong>Booking reference:</strong> {reference(dispute)}
        </p>
        <p style={emailStyles.detail}>
          <strong>Session:</strong> {sessionLine(dispute)}
        </p>
        <p style={emailStyles.detail}>
          <strong>Payment id:</strong> {dispute.paymentIntentId ?? "none on the dispute"}
        </p>
        <p style={emailStyles.detail}>
          <strong>Dispute id:</strong> {dispute.providerDisputeId}
        </p>
      </div>
      <p style={emailStyles.paragraph}>{advice(dispute)}</p>
      <p style={{ ...emailStyles.detail, margin: "14px 0 6px" }}>
        <strong>Evidence on record</strong>
      </p>
      <ul style={{ margin: "0 0 12px", paddingLeft: "20px" }}>
        <li style={emailStyles.detail}>
          {dispute.termsVersion && dispute.termsAcceptedAt
            ? `Coaching Terms version ${dispute.termsVersion} ticked as agreed at ${dubaiTime(dispute.termsAcceptedAt)}` +
              (dispute.expressRequest ? ", with the request to start inside the 14 days." : ".")
            : "No terms record found for this payment."}
        </li>
        <li style={emailStyles.detail}>
          Stripe&apos;s own terms tick was required at checkout (shown on the payment in Stripe).
        </li>
        {dispute.emailsSent.length === 0 ? (
          <li style={emailStyles.detail}>No emails to the customer on record.</li>
        ) : (
          dispute.emailsSent.map((sent) => (
            <li key={`${sent.templateKey}-${sent.sentAt.getTime()}`} style={emailStyles.detail}>
              Email &quot;{sent.templateKey}&quot; sent {dubaiTime(sent.sentAt)} (copies of the
              confirmation are in this inbox).
            </li>
          ))
        )}
        {dispute.refunds.length === 0 ? (
          <li style={emailStyles.detail}>No refunds on this payment.</li>
        ) : (
          dispute.refunds.map((refund) => (
            <li
              key={`${refund.createdAt.getTime()}-${refund.amountFils}`}
              style={emailStyles.detail}
            >
              REFUND on record: {formatAed(refund.amountFils)}, {refund.status}, from{" "}
              {dubaiTime(refund.createdAt)}. Say so in your answer, and never refund again on top of
              a dispute.
            </li>
          ))
        )}
      </ul>
      <p style={emailStyles.muted}>
        {dispute.kind === "outcome"
          ? "The customer has not been told anything by the app about this dispute. This alert comes back once a day for a week after the dispute ended, then stops by itself."
          : "The customer has not been told anything by the app about this dispute. This alert comes back once a day, and stops by itself once Stripe shows the dispute as answered or closed."}
      </p>
    </EmailLayout>
  );
}

export async function renderDisputeNeedsResponse(
  dispute: DisputeForDesk,
  reminder: boolean,
  now: Date,
): Promise<RenderedEmail> {
  const element = (
    <DisputeEmail
      dispute={dispute}
      reminder={reminder}
      companyName={companyName()}
      supportEmail={supportEmail()}
    />
  );
  return {
    subject: disputeSubject(dispute, reminder, now),
    html: await render(element),
    text: await render(element, { plainText: true }),
  };
}
