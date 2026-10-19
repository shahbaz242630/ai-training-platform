/**
 * What a dispute means for a booking (founder, October 2026).
 *
 *   - Stolen card, session still to come: the session is cancelled and its
 *     time freed. The cardholder never wanted it, and it must not go to
 *     whoever used the card.
 *   - Any other dispute: the session stays as booked. A session that was
 *     there for the customer is the evidence that wins "not received"; taking
 *     it away ourselves would make the claim true.
 *   - Money gone (lost, or prevented before a chargeback): a session still to
 *     come is cancelled.
 *   - Won: nothing happens by itself. A session cancelled for a stolen card is
 *     rebooked by a person, if at all; an automatic link could hand it to the
 *     wrong person.
 *   - Once a payment has been disputed, the customer cannot move or choose a
 *     time online, even after it is over: a dispute can never be used as a
 *     free reschedule, and after a stolen-card dispute the person holding the
 *     link may not be the cardholder. A person rebooks by hand.
 *
 * Statuses are the processor's words (API 2026-08-26.dahlia). A status this
 * code does not know is shown to the desk and cancels nothing, which is the
 * side that can be put right.
 */

export type DisputeStage = "inquiry" | "chargeback" | "won" | "money_gone" | "unknown";

const STAGES: Readonly<Record<string, DisputeStage>> = {
  // An inquiry: the bank is asking, no money has moved yet. A refund settles it with no fee.
  warning_needs_response: "inquiry",
  warning_under_review: "inquiry",
  needs_response: "chargeback",
  under_review: "chargeback",
  won: "won",
  // An inquiry that was never escalated, closed after 120 days.
  warning_closed: "won",
  lost: "money_gone",
  // Resolved before a chargeback, usually by giving the cardholder the money back.
  prevented: "money_gone",
};

export function disputeStage(status: string): DisputeStage {
  return STAGES[status] ?? "unknown";
}

/** Stripe's reason for a stolen card. */
export const FRAUD_REASON = "fraudulent";

/**
 * A stolen-card session is cancelled only while there is time to tell the
 * coach. Inside this, the desk decides: an automatic cancellation minutes
 * before a call would land on nobody's screen in time.
 */
export const FRAUD_CANCEL_LEAD_MINUTES = 120;

/**
 * Whether a dispute cancels the sessions on its order that are still to come.
 * A stolen-card chargeback does (with the lead time above); money gone always does.
 */
export function disputeCancels(dispute: {
  readonly status: string;
  readonly reason: string;
}): "fraud" | "money_gone" | null {
  const stage = disputeStage(dispute.status);
  if (stage === "money_gone") return "money_gone";
  if (stage === "chargeback" && dispute.reason === FRAUD_REASON) return "fraud";
  return null;
}

/** The SQL list of statuses a dispute ends in, for queries. */
export const CLOSED_DISPUTE_STATUSES_SQL = "('won', 'warning_closed', 'lost', 'prevented')";
