import { render } from "@react-email/render";
import { companyName, supportEmail } from "@/config/site";
import { EmailLayout, emailStyles } from "./EmailLayout";
import type { RenderedEmail } from "./templates";

/**
 * The desk alerts about the booking's own protections (audit s104), both
 * internal, plain and free of customer details.
 *
 * Holds: unpaid holds sit near the diary's cap. Real demand is a few
 * checkouts an hour; this many at once may be somebody holding times to keep
 * customers out, and at the cap every new customer is turned away.
 *
 * Database: the database is near its plan's size limit. At the limit it
 * becomes read-only, and checkout, settlement and every email stop.
 */

export function holdsNearCapSubject(live: number, cap: number, reminder: boolean): string {
  const base = `Unpaid holds are near the booking limit (${live} of ${cap})`;
  return reminder ? `Reminder: ${base}` : base;
}

export function databaseNearFullSubject(
  usedMb: number,
  limitMb: number,
  reminder: boolean,
): string {
  const base = `The booking database is nearly full (${usedMb} MB of ${limitMb} MB)`;
  return reminder ? `Reminder: ${base}` : base;
}

interface LayoutProps {
  readonly reminder: boolean;
  readonly companyName: string;
  readonly supportEmail: string;
}

function HoldsNearCapEmail(props: LayoutProps & { readonly live: number; readonly cap: number }) {
  const what =
    `${props.live} unpaid holds are live at once, and at ${props.cap} the booking page turns ` +
    "every new customer away. Real customers rarely hold more than a few at a time, so this may " +
    "be somebody starting checkouts to keep times off sale.";
  return (
    <EmailLayout preview={what} companyName={props.companyName} supportEmail={props.supportEmail}>
      <h1 style={emailStyles.heading}>
        {props.reminder
          ? "Still needs you: unpaid holds are near the booking limit"
          : "Unpaid holds are near the booking limit"}
      </h1>
      <p style={emailStyles.paragraph}>{what}</p>
      <p style={emailStyles.paragraph}>
        To check: in Stripe, Payments, look for many unpaid checkouts started close together. Each
        hold ends by itself 35 minutes after it was taken. If it keeps happening, tell the
        developer: the person check can be made stricter in Cloudflare (Turnstile).
      </p>
      <p style={emailStyles.muted}>
        This alert stops by itself once the holds drop below the warning level.
      </p>
    </EmailLayout>
  );
}

function DatabaseNearFullEmail(
  props: LayoutProps & { readonly usedMb: number; readonly limitMb: number },
) {
  const what =
    `The booking database holds ${props.usedMb} MB of its ${props.limitMb} MB limit. At the ` +
    "limit it stops accepting changes, and checkout, payment confirmations and every email stop " +
    "with it.";
  return (
    <EmailLayout preview={what} companyName={props.companyName} supportEmail={props.supportEmail}>
      <h1 style={emailStyles.heading}>
        {props.reminder
          ? "Still needs you: the booking database is nearly full"
          : "The booking database is nearly full"}
      </h1>
      <p style={emailStyles.paragraph}>{what}</p>
      <p style={emailStyles.paragraph}>
        To fix: tell the developer today. A sudden rise usually means somebody is filling in the
        booking form in a loop; a slow one means it is time for a larger plan.
      </p>
      <p style={emailStyles.muted}>
        This alert stops by itself once the database drops below the warning level.
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

export function renderHoldsNearCap(live: number, cap: number, reminder: boolean) {
  return rendered(
    holdsNearCapSubject(live, cap, reminder),
    <HoldsNearCapEmail
      live={live}
      cap={cap}
      reminder={reminder}
      companyName={companyName()}
      supportEmail={supportEmail()}
    />,
  );
}

export function renderDatabaseNearFull(usedMb: number, limitMb: number, reminder: boolean) {
  return rendered(
    databaseNearFullSubject(usedMb, limitMb, reminder),
    <DatabaseNearFullEmail
      usedMb={usedMb}
      limitMb={limitMb}
      reminder={reminder}
      companyName={companyName()}
      supportEmail={supportEmail()}
    />,
  );
}
