/**
 * The words a customer agrees to before paying: the bold key terms, the two
 * tickboxes, and the text Stripe shows beside its own tick and above its Pay
 * button.
 *
 * Kept in one module because the SAME strings are rendered on the booking
 * page and stored, word for word, in the customer's consent record. What we
 * can prove somebody saw has to be exactly what they saw, so the server never
 * accepts this text from the browser; it records these constants.
 *
 * Every number comes from BOOKING_POLICY, so the words agreed to cannot drift
 * from the published Booking and Refund Policy. Bump TERMS_VERSION whenever
 * any of this wording or the published terms change.
 */
import { BOOKING_POLICY } from "./site";

const { moveNoticeHours, moveWindowDays, noShowMinutes, cancellationDays } = BOOKING_POLICY;

/** The date the terms these words point at were published. */
export const TERMS_VERSION = "2026-09-27";

/** The bold box directly above the tickboxes, one item per line. */
export const KEY_TERMS: readonly string[] = [
  "You pay the full price now, in UAE dirhams (AED), for one private session at the time you chose.",
  "No refund if you change your mind, cannot attend or miss your session.",
  `To move your session, email us at least ${moveNoticeHours} hours before it starts. You can move it free to any open time within ${moveWindowDays} days. Less than ${moveNoticeHours} hours before, it cannot be moved.`,
  `If you have not joined within ${noShowMinutes} minutes of the start, the session counts as used.`,
  "If we cancel, or cannot run the session, you choose a full refund or a new time.",
  `If you live in the UK or the EU, you can cancel within ${cancellationDays} days of booking for a full refund, as long as your session has not taken place.`,
  "Coaching is guidance, not a guaranteed result. Your other legal rights are not affected.",
];

/** Always shown, always required. */
export const AGREEMENT_TEXT =
  "I agree to the Coaching Terms and the Booking and Refund Policy. I understand there is no refund if I change my mind, cannot attend or miss my session, except in the cases those terms set out.";

/**
 * Shown, and required, only when the session starts inside the customer's
 * 14-day cancellation period. This is the express request and acknowledgement
 * UK and EU law require before a service starts within that period; without
 * it, a consumer who cancels after the session may owe nothing.
 */
export const EXPRESS_REQUEST_TEXT = `I ask you to hold my session on the date I chose, which is within my ${cancellationDays}-day cancellation period. I understand that if I cancel before it starts I get a full refund, that if I cancel during it I pay for the part already delivered, and that once it has been delivered in full I can no longer cancel.`;

/** Beside Stripe's own required tick. Markdown links; Stripe allows 1,200 characters. */
export function stripeTermsMessage(links: { terms: string; policy: string }): string {
  return `I agree to the [Coaching Terms](${links.terms}), including the no-refund and ${moveNoticeHours}-hour rescheduling rules in the [Booking and Refund Policy](${links.policy}).`;
}

/** Directly above Stripe's Pay button. */
export const STRIPE_SUBMIT_MESSAGE = `One private coaching session. No refund if you change your mind or miss it; move it free if you ask at least ${moveNoticeHours} hours before. If we cancel, you choose a refund or a new time.`;
