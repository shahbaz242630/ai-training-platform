import { render } from "@react-email/render";
import { companyName, supportEmail } from "@/config/site";
import { getSessionBySlug } from "@/config/sessions";
import type { PaidButUnscheduled } from "@/data/audit-events";
import type { CalendarProblem } from "@/data/calendar-watch";
import type { RefundNeedingAttention } from "@/data/refund-queries";
import { bookingReference } from "@/domain/booking/withdrawal";
import { formatAed } from "@/lib/money";
import { GST_TIMEZONE } from "@/lib/time";
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

/** "Tue 20 Oct, 19:00 Dubai time": the desk works in Dubai time. */
export function dubaiTime(instant: Date): string {
  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: GST_TIMEZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(instant);
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: GST_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
  return `${day.replace(",", "")}, ${time} Dubai time`;
}

const CANNOT_GO_AHEAD =
  "If the session cannot go ahead, contact the customer from the knowledgecentre@ inbox.";

function calendarAlertText(problem: CalendarProblem): readonly string[] {
  if (problem.kind === "gone") {
    return [
      "The Outlook event for this booked session has been deleted or cancelled. The customer has " +
        "not been told: they still expect the session at the time below and still get their " +
        "reminders. The time stays blocked, so nobody else can book it.",
      "To fix: restore the event from Deleted Items in Outlook. Do not make a new event: the " +
        "customer's join link belongs to the original one. This alert stops by itself within 5 " +
        "minutes of the restore, or once the session time has passed.",
    ];
  }
  return [
    "The Outlook event for this booked session now shows a different time from the one the " +
      "customer booked. Moving the event in Outlook does not move the booking, and the customer " +
      "has not been told.",
    "To fix: move the event back to the booked time. If the session really has to move, ask the " +
      "customer to use the Manage my booking link in their emails. This alert stops by itself " +
      "once the calendar matches the booking.",
  ];
}

export function calendarEventChangedSubject(problem: CalendarProblem, reminder: boolean): string {
  const what =
    problem.kind === "gone"
      ? "Session missing from the calendar"
      : "Session moved in the calendar only";
  const base = `${what}: booking ${bookingReference(problem.bookingId)}, ${dubaiTime(problem.booked.start)}`;
  return reminder ? `Reminder: ${base}` : base;
}

interface CalendarEventChangedEmailProps {
  readonly problem: CalendarProblem;
  readonly reminder: boolean;
  readonly companyName: string;
  readonly supportEmail: string;
}

function CalendarEventChangedEmail({
  problem,
  reminder,
  ...layout
}: CalendarEventChangedEmailProps) {
  const [what, fix] = calendarAlertText(problem);
  const heading =
    problem.kind === "gone"
      ? "A booked session is missing from the calendar"
      : "A booked session was moved in the calendar only";
  return (
    <EmailLayout preview={what ?? heading} {...layout}>
      <h1 style={emailStyles.heading}>
        {reminder ? `Still needs you: ${heading.toLowerCase()}` : heading}
      </h1>
      <p style={emailStyles.paragraph}>{what}</p>
      <div style={{ margin: "0 0 20px" }}>
        <p style={emailStyles.detail}>
          <strong>Booking reference:</strong> {bookingReference(problem.bookingId)}
        </p>
        <p style={emailStyles.detail}>
          <strong>Booked:</strong> {dubaiTime(problem.booked.start)}
        </p>
        {problem.kind === "moved" ? (
          <p style={emailStyles.detail}>
            <strong>Calendar shows:</strong> {dubaiTime(problem.calendar.start)}
          </p>
        ) : null}
      </div>
      <p style={emailStyles.paragraph}>{fix}</p>
      <p style={emailStyles.muted}>{CANNOT_GO_AHEAD} Nothing has been changed for the customer.</p>
    </EmailLayout>
  );
}

export async function renderCalendarEventChanged(
  problem: CalendarProblem,
  reminder: boolean,
): Promise<RenderedEmail> {
  const element = (
    <CalendarEventChangedEmail
      problem={problem}
      reminder={reminder}
      companyName={companyName()}
      supportEmail={supportEmail()}
    />
  );
  return {
    subject: calendarEventChangedSubject(problem, reminder),
    html: await render(element),
    text: await render(element, { plainText: true }),
  };
}

/*
  Paid, with no session time: the held time was lost before the booking was
  confirmed (cancelled or deleted in Outlook), or the payment landed after the
  hold expired. Until this alert, only a log line said so. It carries the
  customer's own link to choose a new time, for the desk to forward: a link
  to the booking, still nothing about who the customer is.
*/
function paidBookingReference(problem: PaidButUnscheduled): string {
  return problem.bookingId === null ? "unknown" : bookingReference(problem.bookingId);
}

export function paidBookingNeedsTimeSubject(problem: PaidButUnscheduled, reminder: boolean) {
  const base = `Paid, no session time: booking ${paidBookingReference(problem)}, ${formatAed(problem.amountFils)}`;
  return reminder ? `Reminder: ${base}` : base;
}

interface PaidBookingNeedsTimeEmailProps {
  readonly problem: PaidButUnscheduled;
  readonly reminder: boolean;
  readonly chooseTimeUrl: string | null;
  readonly companyName: string;
  readonly supportEmail: string;
}

function PaidBookingNeedsTimeEmail({
  problem,
  reminder,
  chooseTimeUrl,
  ...layout
}: PaidBookingNeedsTimeEmailProps) {
  const session =
    (problem.sessionSlug === null ? undefined : getSessionBySlug(problem.sessionSlug))?.title ??
    "a session";
  const what =
    `A customer has paid for ${session}, but the booking has no time on the calendar: the held ` +
    "time was lost before the booking was confirmed, or the payment arrived after the hold had " +
    "expired." +
    (problem.customerEmailedAt !== null && !problem.disputed
      ? ` The customer was emailed their own link to choose a new time on ${dubaiTime(problem.customerEmailedAt)} (a copy is in this inbox).`
      : " The customer has not had a confirmation and has not been told.");
  const heading = "A customer has paid and has no session time";
  return (
    <EmailLayout preview={what} {...layout}>
      <h1 style={emailStyles.heading}>
        {reminder ? `Still needs you: ${heading.toLowerCase()}` : heading}
      </h1>
      <p style={emailStyles.paragraph}>{what}</p>
      <div style={{ margin: "0 0 20px" }}>
        <p style={emailStyles.detail}>
          <strong>Booking reference:</strong> {paidBookingReference(problem)}
        </p>
        <p style={emailStyles.detail}>
          <strong>Amount:</strong> {formatAed(problem.amountFils)}
        </p>
        <p style={emailStyles.detail}>
          <strong>Payment id:</strong> {problem.paymentIntentId ?? "no payment on record"}
        </p>
      </div>
      {chooseTimeUrl && problem.customerEmailedAt !== null && !problem.disputed ? (
        <>
          <p style={emailStyles.paragraph}>
            Nothing to do unless the customer writes. They choose any open time themselves from
            their link, free, and it does not use up their one move. If they ask for their money
            back instead, refund the payment in full in Stripe. Do not charge again. If they lose
            the link, this one works too:
          </p>
          <p style={emailStyles.detail}>
            <a href={chooseTimeUrl}>{chooseTimeUrl}</a>
          </p>
          <p style={emailStyles.muted}>
            The link works for {CHOOSE_TIME_LINK_DAYS} days; each reminder carries a fresh one. This
            alert stops by itself once the customer has chosen a time, or once the payment is
            refunded in full in Stripe. Until then it comes back once a day.
          </p>
        </>
      ) : problem.disputed ? (
        <>
          <p style={emailStyles.paragraph}>
            This payment was disputed and the dispute is over, so the customer was not sent a link
            and cannot choose a time online: after a stolen-card dispute, the person who booked may
            not be the cardholder. Check the dispute in Stripe first. If the session should go
            ahead, agree a time with the customer from the knowledgecentre@ inbox and book it by
            hand; otherwise refund the payment in full. Do not charge again.
          </p>
          <p style={emailStyles.muted}>
            This alert stops by itself once the booking has a time, or once the payment is refunded
            in full in Stripe. Until then it comes back once a day.
          </p>
        </>
      ) : chooseTimeUrl ? (
        <>
          <p style={emailStyles.paragraph}>
            To fix: find the customer in Stripe by the payment id and write to them from the
            knowledgecentre@ inbox. Apologise, and offer them a new time or a full refund. For a new
            time, send them this link: they choose any open time themselves, free, and it does not
            use up their one move. Any goodwill part refund comes after they have chosen: a
            part-refunded booking cannot be given a time from the link. Do not charge again.
          </p>
          <p style={emailStyles.detail}>
            <a href={chooseTimeUrl}>{chooseTimeUrl}</a>
          </p>
          <p style={emailStyles.muted}>
            The link works for {CHOOSE_TIME_LINK_DAYS} days; each reminder carries a fresh one. This
            alert stops by itself once the customer has chosen a time, or once the payment is
            refunded in full in Stripe. Until then it comes back once a day.
          </p>
        </>
      ) : (
        <>
          <p style={emailStyles.paragraph}>
            To fix: find the customer in Stripe by the payment id, write to them from the
            knowledgecentre@ inbox, apologise, and offer a full refund. Do not charge again.
          </p>
          <p style={emailStyles.muted}>
            {problem.fullyPaid
              ? "A new time cannot be offered from a link for this one. "
              : "This order has been partly refunded, so a new time cannot be offered from a link. "}
            This alert stops by itself once the payment is refunded in full in Stripe. Until then it
            comes back once a day.
          </p>
        </>
      )}
    </EmailLayout>
  );
}

/** How long the customer's choose-a-time link in a desk alert works. */
export const CHOOSE_TIME_LINK_DAYS = 7;

/**
 * `chooseTimeUrl` is the customer's own link to pick a new time, made fresh
 * for each send. Null when there is no booking to give a time to, the order
 * is part-refunded (only a fully paid order confirms), or no secret is set.
 */
export async function renderPaidBookingNeedsTime(
  problem: PaidButUnscheduled,
  reminder: boolean,
  chooseTimeUrl: string | null,
): Promise<RenderedEmail> {
  const element = (
    <PaidBookingNeedsTimeEmail
      problem={problem}
      reminder={reminder}
      chooseTimeUrl={chooseTimeUrl}
      companyName={companyName()}
      supportEmail={supportEmail()}
    />
  );
  return {
    subject: paidBookingNeedsTimeSubject(problem, reminder),
    html: await render(element),
    text: await render(element, { plainText: true }),
  };
}
