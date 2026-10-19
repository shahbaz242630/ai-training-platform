import { render } from "@react-email/render";
import { companyName, supportEmail } from "@/config/site";
import { EmailLayout, emailStyles } from "./EmailLayout";
import type { RenderedEmail } from "./templates";

/**
 * The desk alerts about payment events, both internal, plain and free of
 * customer details.
 *
 * Missing: the sweep found checkouts still pending long after they ended and
 * finished them by asking the processor. The customers are looked after; the
 * cause is not, and until it is fixed every booking waits for its
 * confirmation. A single delivery Stripe is still retrying can raise it too,
 * so it says "delayed or missing".
 *
 * Failing: the sweep could not ask the processor at all, hours after the
 * checkout. The safety net itself is down, and nothing else would say so.
 */

const DASHBOARD_STEPS =
  "In the Stripe Dashboard, open Workbench, Webhooks, and the coaching endpoint. Check it is " +
  "enabled and look at the recent deliveries. A signing secret that no longer matches the app " +
  "shows as failed deliveries; a disabled endpoint shows as none.";

export function paymentEventsMissingSubject(count: number, reminder: boolean): string {
  const base = `Payment notices from Stripe are delayed or missing (${count} in the last day)`;
  return reminder ? `Reminder: ${base}` : base;
}

export function reconciliationFailingSubject(count: number, reminder: boolean): string {
  const base = `Checking unfinished payments with Stripe is failing (${count} waiting)`;
  return reminder ? `Reminder: ${base}` : base;
}

interface AlertProps {
  readonly count: number;
  readonly reminder: boolean;
  readonly companyName: string;
  readonly supportEmail: string;
}

function PaymentEventsMissingEmail(props: AlertProps) {
  const what =
    `In the last 24 hours, ${props.count} ${props.count === 1 ? "checkout was" : "checkouts were"} ` +
    "finished by asking Stripe directly, because Stripe's notice to the booking app was delayed " +
    "or never arrived. Paid customers among them were booked and emailed, or are in a paid " +
    "booking alert if their time was gone; abandoned checkouts gave their times back. New " +
    "customers wait up to 45 minutes for their confirmation until the notices arrive again.";
  return (
    <EmailLayout preview={what} companyName={props.companyName} supportEmail={props.supportEmail}>
      <h1 style={emailStyles.heading}>
        {props.reminder
          ? "Still needs you: payment notices are delayed or missing"
          : "Payment notices are delayed or missing"}
      </h1>
      <p style={emailStyles.paragraph}>{what}</p>
      <p style={emailStyles.paragraph}>To fix: {DASHBOARD_STEPS}</p>
      <p style={emailStyles.muted}>
        This alert stops by itself a day after the last checkout had to be finished this way.
      </p>
    </EmailLayout>
  );
}

function ReconciliationFailingEmail(props: AlertProps) {
  const what =
    `${props.count} unfinished ${props.count === 1 ? "checkout" : "checkouts"} could not be ` +
    "checked with Stripe for over three hours. If Stripe's own notices are also missing, a " +
    "customer may have paid and have no booking and no email.";
  return (
    <EmailLayout preview={what} companyName={props.companyName} supportEmail={props.supportEmail}>
      <h1 style={emailStyles.heading}>
        {props.reminder
          ? "Still needs you: checking unfinished payments is failing"
          : "Checking unfinished payments is failing"}
      </h1>
      <p style={emailStyles.paragraph}>{what}</p>
      <p style={emailStyles.paragraph}>
        To fix: check that the booking app&apos;s Stripe key still exists and may read Checkout
        Sessions (Developers, API keys). Then look in Stripe, Payments, for any payment in the last
        day without a &quot;Payment received&quot; email from the Knowledge Centre.{" "}
        {DASHBOARD_STEPS}
      </p>
      <p style={emailStyles.muted}>
        This alert stops by itself once every unfinished checkout can be checked again.
      </p>
    </EmailLayout>
  );
}

async function rendered(subject: string, element: React.ReactElement): Promise<RenderedEmail> {
  return {
    subject,
    html: await render(element),
    text: await render(element, { plainText: true }),
  };
}

export function renderPaymentEventsMissing(count: number, reminder: boolean) {
  return rendered(
    paymentEventsMissingSubject(count, reminder),
    <PaymentEventsMissingEmail
      count={count}
      reminder={reminder}
      companyName={companyName()}
      supportEmail={supportEmail()}
    />,
  );
}

export function renderReconciliationFailing(count: number, reminder: boolean) {
  return rendered(
    reconciliationFailingSubject(count, reminder),
    <ReconciliationFailingEmail
      count={count}
      reminder={reminder}
      companyName={companyName()}
      supportEmail={supportEmail()}
    />,
  );
}
