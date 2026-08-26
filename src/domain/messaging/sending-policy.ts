/**
 * Whether a given message may be sent to a given person.
 *
 * THE RULE THIS EXISTS TO PROTECT:
 *
 *   A booking confirmation, a reminder, the Teams joining details and the
 *   follow-up are TRANSACTIONAL. They are about a session somebody has paid
 *   for, and they send whether or not the marketing box was ticked. Not
 *   sending one because somebody declined offers would mean a customer paid
 *   for a session and was never told when it is.
 *
 *   Offers, news and anything else are MARKETING, and send only with a
 *   recorded opt-in that has not since been withdrawn.
 *
 * The danger is not that anybody would decide otherwise; it is that a future
 * change adds `if (customer.marketingConsent)` in front of a send loop that
 * happens to include the confirmation. So a template cannot be sent without
 * first being classified: the classification lives in one table below, and
 * anything missing from it cannot be sent at all.
 */

export type MessageKind = "transactional" | "marketing";

export type TemplateKey =
  | "booking_confirmation"
  | "intake_link"
  | "reminder_24h"
  | "reminder_3h"
  | "reschedule_confirmation"
  | "cancellation_confirmation"
  | "payment_receipt"
  | "follow_up"
  | "session_offers"
  | "newsletter";

/**
 * Every template, and what kind it is. A template that is not listed here
 * cannot be sent - which is the point. Adding one is a deliberate act that
 * forces the question "is this about their booking, or is this marketing?".
 */
export const TEMPLATE_KINDS: Readonly<Record<TemplateKey, MessageKind>> = {
  // About a session they have paid for. These send regardless of consent.
  booking_confirmation: "transactional",
  intake_link: "transactional",
  reminder_24h: "transactional",
  reminder_3h: "transactional",
  reschedule_confirmation: "transactional",
  cancellation_confirmation: "transactional",
  payment_receipt: "transactional",
  follow_up: "transactional",

  // Anything else. These need consent.
  session_offers: "marketing",
  newsletter: "marketing",
};

/** The parts of a customer record this decision depends on, and nothing else. */
export interface ConsentState {
  readonly marketingConsent: boolean;
  /**
   * Set when somebody deliberately withdrew. Outranks the consent flag: a
   * withdrawal is permanent until they opt in again, and must survive a later
   * booking form that happens to arrive with the box ticked.
   */
  readonly unsubscribedAt: Date | null;
}

export interface SendDecision {
  readonly allowed: boolean;
  /** Plain enough to put in an audit trail and have it mean something later. */
  readonly reason: string;
}

export function decideSend(kind: MessageKind, consent: ConsentState): SendDecision {
  if (kind === "transactional") {
    /*
      Deliberately checked BEFORE anything about consent, and deliberately not
      gated on unsubscribedAt either. Unsubscribing stops marketing; it does
      not cancel somebody's session or waive their right to be told when it
      is. Someone who unsubscribes and then books still gets their booking
      confirmation.
    */
    return { allowed: true, reason: "transactional: about a session they booked" };
  }

  if (consent.unsubscribedAt !== null) {
    return { allowed: false, reason: "marketing: unsubscribed" };
  }
  if (!consent.marketingConsent) {
    return { allowed: false, reason: "marketing: no recorded consent" };
  }
  return { allowed: true, reason: "marketing: consent on record" };
}

/**
 * The entry point everything sending email should use.
 *
 * Takes a template key rather than a kind, so the caller cannot classify its
 * own message as transactional to get past the check.
 */
export function decideSendTemplate(templateKey: TemplateKey, consent: ConsentState): SendDecision {
  const kind = TEMPLATE_KINDS[templateKey];
  if (kind === undefined) {
    // Unreachable through the type system, but reachable from JSON, a database
    // row, or a future template somebody forgot to classify. Refusing is the
    // safe direction: an unsent marketing email is a nuisance, an unclassified
    // one sent to somebody who opted out is a complaint.
    return { allowed: false, reason: "unknown template: not classified" };
  }
  return decideSend(kind, consent);
}

/** Convenience for the common question, kept honest by delegating to the above. */
export function isTransactional(templateKey: TemplateKey): boolean {
  return TEMPLATE_KINDS[templateKey] === "transactional";
}
