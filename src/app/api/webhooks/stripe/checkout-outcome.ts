import type { QueryRunner } from "@/data/db";
import { withTransaction } from "@/data/db";
import { queueForOrder } from "@/data/communications";
import { bookingIdsForOrder, confirmBookingOnCalendar } from "@/data/confirmation";
import { linkDisputesAtSettlement } from "@/data/disputes";
import { linkFraudWarningsAtSettlement } from "@/data/fraud-warnings";
import { releaseFailedOrder, settlePaidOrder, type SettlementOutcome } from "@/data/settlement";
import { messagesOnSettlement } from "@/domain/messaging/schedule";
import type { CheckoutSnapshot } from "@/domain/payments/provider";
import { getSchedulingProvider } from "@/domain/scheduling/factory";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * What a checkout's result does, wherever the result came from: Stripe's
 * event, or the sweep asking Stripe about an order whose event never came.
 * One path, so an order settled by asking is settled exactly as one settled
 * by its event.
 */

export type CheckoutOutcome = SettlementOutcome | "awaiting_payment";

/** Apply a checkout result to its order. Run inside the caller's transaction. */
export async function applyCheckoutOutcome(
  runner: QueryRunner,
  event: CheckoutSnapshot & { readonly orderId: string },
  now: Date,
): Promise<CheckoutOutcome> {
  /*
    THREE outcomes, not two. `unpaid` is a real one and it is neither a
    success nor a failure: with a delayed-notification payment method the
    completed event arrives while the money is still in flight, and the
    result lands hours later as its own event.

    Treating it as a failure - which a two-way branch does by default -
    marked the order failed and RELEASED THE SLOT while the customer was
    still paying. Someone else could then buy that time, and when the money
    arrived the payer had no session. Waiting is the entire correct
    response: keep the order pending, keep the hold, and settle when the
    later event says what actually happened.
  */
  if (event.outcome === "unpaid") {
    // Waiting is the whole answer. The webhook still records its delivery as finished.
    return "awaiting_payment";
  }

  const settled: SettlementOutcome =
    event.outcome === "paid"
      ? await settlePaidOrder(runner, {
          orderId: event.orderId,
          slotHoldId: event.slotHoldId,
          // The handle a refund names. Stored now, while the event that
          // carries it is in hand; absent, the write keeps what it had.
          stripePaymentIntentId: event.paymentIntentId,
          // Checked against the order rather than trusted. A verified
          // signature proves the event is from the processor, not that it
          // is about this order or for the right amount.
          checkoutSessionId: event.checkoutSessionId,
          paidAmountFils: event.amountFils,
          paidCurrency: event.currency,
          now,
        })
      : await releaseFailedOrder(runner, {
          orderId: event.orderId,
          slotHoldId: event.slotHoldId,
          // Checked here too. Releasing somebody else's slot needs no
          // money, so the failure path is the cheaper one to attack.
          checkoutSessionId: event.checkoutSessionId,
          paidAmountFils: event.amountFils,
          paidCurrency: event.currency,
          now,
        });

  /*
    The first message a paying customer receives, queued in the same
    transaction as the settlement so that neither can exist without the
    other. It says the payment is in and the time is reserved; the joining
    details follow when the calendar side confirms.
  */
  /*
    Paid without a time gets it too: the contract is confirmed in writing, with
    the terms, whether or not the time survived. The email says the time is
    still to be chosen; the link to choose one follows from the sweep.
  */
  if (settled === "settled" || settled === "paid_without_slot") {
    await queueForOrder(runner, event.orderId, messagesOnSettlement(now));
    /*
      A dispute can reach us before the payment does. Linked here, in the same
      transaction, so a stolen-card dispute cancels the session before any
      confirmation is sent, not at the next sweep.
    */
    await linkDisputesAtSettlement(runner, event.orderId, event.paymentIntentId, now);
    // An early fraud warning too: linked for the desk to decide, and online moves stop.
    await linkFraudWarningsAtSettlement(runner, event.orderId, event.paymentIntentId);
  }

  return settled;
}

/**
 * The step after settlement: the calendar event becomes the session, with a
 * join link, and the confirmation and reminders are queued. Never throws -
 * the processor has been answered by the settlement, and a retry belongs to
 * the sweep, not to Stripe.
 */
export async function confirmOnCalendar(orderId: string): Promise<void> {
  let provider;
  try {
    provider = getSchedulingProvider();
  } catch (error) {
    logger.error("the calendar is not configured; confirmation is deferred to the sweep", {
      orderId,
      error: (error as Error).message,
    });
    return;
  }

  const bookingIds = await withTransaction((runner) => bookingIdsForOrder(runner, orderId));
  for (const bookingId of bookingIds) {
    try {
      const result = await confirmBookingOnCalendar({
        bookingId,
        provider,
        now: new Date(),
        transaction: withTransaction,
      });
      logger.info("calendar confirmation after settlement", { bookingId, result });
    } catch (error) {
      logger.error("calendar confirmation failed after settlement; the sweep will retry", {
        bookingId,
        error: (error as Error).message,
      });
    }
  }
}

/**
 * Say what happened, and shout about the one case that needs a human.
 *
 * Every branch here answers 2xx to the processor. None of these are things a
 * retry can improve, and a delivery retried forever buries the ones that
 * genuinely failed.
 */
export async function reportOutcome(
  outcome: SettlementOutcome | "duplicate" | "awaiting_payment",
  eventId: string,
  orderId: string,
  eventType: string,
): Promise<void> {
  switch (outcome) {
    /*
      Money in flight. Recorded, acknowledged, and deliberately left alone -
      the order stays pending and the hold keeps running, so the slot is still
      the payer's when the result arrives.
    */
    case "awaiting_payment":
      logger.info("payment is in flight, waiting for the result", {
        orderId,
        eventId,
        eventType,
      });
      return;

    /*
      Correct and boring - and, until now, invisible. The audit row was the
      only trace, so a processor redelivering the same event a hundred times
      would spend a hundred database round trips without a line in the log
      anybody reads first. Info, not warn: one duplicate is the retry working
      as designed. It is the count that would mean something.
    */
    case "duplicate":
      await recordAudit({
        action: "webhook.duplicate_ignored",
        actor: { kind: "provider", provider: "stripe" },
        subject: `order:${orderId}`,
        metadata: { eventId },
      });
      logger.info("a duplicate delivery was ignored", { orderId, eventId, eventType });
      return;

    case "settled":
      await recordAudit({
        action: "order.payment_succeeded",
        actor: { kind: "provider", provider: "stripe" },
        subject: `order:${orderId}`,
        metadata: { eventId },
      });
      logger.info("payment settled and booking scheduled", { orderId, eventId });
      return;

    /*
      THE ONE THAT NEEDS A HUMAN. The money is ours and the customer has no
      time booked - a delayed payment that landed after the hold expired, most
      likely. The order stays paid, the booking waits, and somebody has to
      reschedule it by hand.

      It is deliberately logged at error level despite nothing having gone
      wrong technically: the alternative is a customer who has paid, is
      expecting a session, and appears in no calendar.
    */
    case "paid_without_slot":
      await recordAudit({
        action: "order.payment_succeeded",
        actor: { kind: "provider", provider: "stripe" },
        subject: `order:${orderId}`,
        metadata: { eventId, scheduled: false },
      });
      logger.error("PAID BUT NOT SCHEDULED - needs rescheduling by hand, do not charge again", {
        orderId,
        eventId,
      });
      return;

    case "released":
      await recordAudit({
        action: "order.payment_failed",
        actor: { kind: "provider", provider: "stripe" },
        subject: `order:${orderId}`,
        metadata: { eventId, eventType },
      });
      logger.info("payment failed or expired, slot released", { orderId, eventId, eventType });
      return;

    case "already_settled":
      logger.info("a settled order received another delivery, nothing done", { orderId, eventId });
      return;

    /*
      The event does not belong to this order, or disagrees about the amount.
      Never settled. Acknowledged so it is not retried - a retry cannot make a
      mismatched event match - and logged at error level, because on a money
      path this is either a misconfiguration or somebody trying it on.
    */
    case "mismatched":
      /*
        Written to the trail, not only logged. This outcome means either a
        misconfiguration or somebody trying it on, and those are exactly the
        ones worth durable evidence of - leaving them in stdout is the failure
        the audit table was built to end.
      */
      await recordAudit({
        action: "webhook.signature_rejected",
        actor: { kind: "provider", provider: "stripe" },
        subject: `order:${orderId}`,
        metadata: { eventId, eventType, reason: "event did not match the order it named" },
      });
      logger.error("a payment event did not match the order it named", {
        orderId,
        eventId,
        eventType,
      });
      return;

    case "refused":
      /*
        Written to the trail, not only logged. This outcome means either a
        misconfiguration or somebody trying it on, and those are exactly the
        ones worth durable evidence of - leaving them in stdout is the failure
        the audit table was built to end.
      */
      await recordAudit({
        action: "webhook.signature_rejected",
        actor: { kind: "provider", provider: "stripe" },
        subject: `order:${orderId}`,
        metadata: { eventId, eventType, reason: "state machine refused the move" },
      });
      logger.error("a payment event was refused by the state machine", {
        orderId,
        eventId,
        eventType,
      });
      return;

    case "unknown_order":
      // Verified by signature, so it really came from the processor - and yet
      // names an order we have never written. This is the shape of somebody
      // guessing at order ids, so it is kept rather than only logged.
      /*
        Written to the trail, not only logged. This outcome means either a
        misconfiguration or somebody trying it on, and those are exactly the
        ones worth durable evidence of - leaving them in stdout is the failure
        the audit table was built to end.
      */
      await recordAudit({
        action: "webhook.signature_rejected",
        actor: { kind: "provider", provider: "stripe" },
        subject: `order:${orderId}`,
        metadata: { eventId, eventType, reason: "no such order" },
      });
      logger.error("a verified payment event named an order we do not have", { orderId, eventId });
      return;
  }
}
