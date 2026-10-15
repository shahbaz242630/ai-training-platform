import { render } from "@react-email/render";
import { companyName, supportEmail } from "@/config/site";
import type { RefundNeedingAttention } from "@/data/refunds";
import { formatAed } from "@/lib/money";
import { EmailLayout, emailStyles } from "./EmailLayout";
import type { RenderedEmail } from "./templates";

/**
 * Emails to the booking desk itself, never to a customer.
 *
 * Internal and plain. They carry what a person needs to find the payment and
 * act (the booking reference, the amount, the payment id, what went wrong)
 * and nothing about the customer: no name, no email address. Anyone who can
 * read the desk inbox can read these, and the payment in Stripe holds the rest.
 */

const ACTION =
  "Check the payment in Stripe and refund it by hand if it has not been refunded. " +
  "This alert stops by itself once the refund is recorded.";

function amountLabel(refund: RefundNeedingAttention): string {
  return refund.currency === "AED"
    ? formatAed(refund.amountFils)
    : `${refund.currency} ${(refund.amountFils / 100).toFixed(2)}`;
}

/** What went wrong, in plain words, from the refund's status and its last error code. */
export function refundAlertReason(refund: RefundNeedingAttention): string {
  switch (refund.status) {
    case "pending":
      return "The refund has been pending in Stripe for over 3 days.";
    // Says only what is known: the provider may never have been asked (the sweep was down, say).
    case "due":
    case "issuing":
      return refund.lastError
        ? `The refund has not gone through for over a day (last code: ${refund.lastError}).`
        : "The refund has not gone through for over a day.";
    case "canceled":
      return "The refund was cancelled in Stripe, so the money has not gone back.";
    default:
      return failedReason(refund.lastError);
  }
}

function failedReason(code: string | null): string {
  switch (code) {
    case "charge_already_refunded":
    case "amount_too_large":
      return (
        "Stripe says this payment has already been refunded, at least in part, outside the " +
        "automatic refund, so the automatic refund stopped."
      );
    case "key_window_passed":
      return (
        "The automatic refund could not get a clear answer from the payment provider within a " +
        "day, so it stopped rather than risk refunding twice."
      );
    case "no_payment_intent":
      return "The order has no payment on record to refund, so it could not be refunded automatically.";
    case "order_partially_refunded":
      return "The order was already partly refunded, so what is left needs working out by hand.";
    case "order_not_paid":
      return "The order is not marked as paid, so nothing was refunded automatically.";
    case null:
      return (
        "The refund failed after it was made, for example because the card issuer refused it " +
        "or the card is closed."
      );
    default:
      return `The automatic refund failed (code: ${code}).`;
  }
}

export function refundNeedsAttentionSubject(refund: RefundNeedingAttention, reminder: boolean) {
  const base = `Refund needs you: booking ${refund.bookingReference ?? "unknown"}, ${amountLabel(refund)}`;
  return reminder ? `Reminder: ${base}` : base;
}

interface RefundNeedsAttentionEmailProps {
  readonly refund: RefundNeedingAttention;
  readonly reminder: boolean;
  readonly companyName: string;
  readonly supportEmail: string;
}

function RefundNeedsAttentionEmail({
  refund,
  reminder,
  ...layout
}: RefundNeedsAttentionEmailProps) {
  return (
    <EmailLayout preview={refundAlertReason(refund)} {...layout}>
      <h1 style={emailStyles.heading}>
        {reminder ? "Still needs you: a refund" : "A refund needs you"}
      </h1>
      <p style={emailStyles.paragraph}>{refundAlertReason(refund)}</p>
      <div style={{ margin: "0 0 20px" }}>
        <p style={emailStyles.detail}>
          <strong>Booking reference:</strong> {refund.bookingReference ?? "unknown"}
        </p>
        <p style={emailStyles.detail}>
          <strong>Amount:</strong> {amountLabel(refund)}
        </p>
        <p style={emailStyles.detail}>
          <strong>Payment id:</strong> {refund.paymentIntentId ?? "no payment on record"}
        </p>
      </div>
      <p style={emailStyles.paragraph}>{ACTION}</p>
      <p style={emailStyles.muted}>
        To find the payment, search for it in Stripe by its payment id
        {refund.paymentIntentId ? "" : ", or by the booking reference"}.
      </p>
    </EmailLayout>
  );
}

export async function renderRefundNeedsAttention(
  refund: RefundNeedingAttention,
  reminder: boolean,
): Promise<RenderedEmail> {
  const element = (
    <RefundNeedsAttentionEmail
      refund={refund}
      reminder={reminder}
      companyName={companyName()}
      supportEmail={supportEmail()}
    />
  );
  return {
    subject: refundNeedsAttentionSubject(refund, reminder),
    html: await render(element),
    text: await render(element, { plainText: true }),
  };
}
