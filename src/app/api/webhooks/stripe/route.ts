import { NextResponse } from "next/server";
import { withTransaction } from "@/data/db";
import { claimWebhookEvent, markWebhookProcessed } from "@/data/webhook-events";
import { releaseFailedOrder, settlePaidOrder, type SettlementOutcome } from "@/data/settlement";
import { getPaymentProvider } from "@/domain/payments/factory";
import { InvalidSignatureError } from "@/domain/payments/provider";
import { recordAudit } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * The only thing in this application that may confirm a payment.
 *
 * Not the success page, not the browser, not an admin clicking something.
 * A customer can pay and never reach the success page - a lost connection is
 * enough - and anybody can open the success URL having paid nothing. So the
 * signed event is the authority and nothing else is.
 *
 * THE ORDER OF OPERATIONS IS THE WHOLE THING:
 *
 *   1. verify the signature   against the RAW body
 *   2. claim the event id     inside the transaction, BEFORE acting
 *   3. act                    in that same transaction
 *
 * Claiming before acting is what makes a retry harmless. Acting first and
 * recording second means a crash between them turns the next retry into a
 * second confirmed booking, which is precisely what the ledger exists to
 * prevent.
 */

export const dynamic = "force-dynamic";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request): Promise<NextResponse> {
  let payments;
  try {
    payments = getPaymentProvider();
  } catch {
    /*
      Unconfigured means we cannot verify anything. Accepting the delivery
      would be accepting an unverified instruction to confirm a booking, so
      this refuses - loudly, and without pretending to have handled it.
    */
    logger.error("a stripe webhook arrived while payments are not configured");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  /*
    The RAW body. A signature is computed over exact bytes, so anything that
    has been parsed and re-serialised is no longer the thing that was signed.
    request.json() here would silently make verification meaningless.
  */
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  let event;
  try {
    event = await payments.verifyEvent(rawBody, signature);
  } catch (error) {
    if (error instanceof InvalidSignatureError) {
      /*
        400, not 500. A forged or malformed delivery is a bad request, and
        answering 500 would invite the processor to retry something that can
        never become valid.
      */
      await recordAudit({
        action: "webhook.signature_rejected",
        actor: { kind: "provider", provider: "stripe" },
        subject: "stripe:unverified",
      });
      logger.error("a stripe webhook failed signature verification");
      return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
    }
    logger.error("a stripe webhook could not be read", { error: (error as Error).message });
    return NextResponse.json({ error: "Unreadable" }, { status: 400 });
  }

  /*
    Stripe sends far more event types than this integration consumes. An
    unrecognised one is acknowledged and dropped: answering with an error
    would have it retried forever for no reason.
  */
  if (event.ignorable) {
    return NextResponse.json({ ok: true, ignored: event.type });
  }

  /*
    The order id arrives in processor metadata, so it is external input like
    any other. A value that is not a UUID reaches Postgres, raises an
    invalid-syntax error, becomes a 500, and is then retried by the processor
    FOREVER. Refusing it here acknowledges the delivery instead.
  */
  if (event.orderId !== null && !UUID_PATTERN.test(event.orderId)) {
    logger.error("a payment event carried an order id that is not a UUID", {
      eventId: event.eventId,
      type: event.type,
    });
    return NextResponse.json({ ok: true, ignored: "malformed order id" });
  }

  if (event.orderId === null) {
    // Verified, consumable, and carrying nothing that identifies an order.
    // Acknowledged so it is not retried, and logged because it should not happen.
    logger.error("a stripe event we consume carried no order id", {
      eventId: event.eventId,
      type: event.type,
    });
    return NextResponse.json({ ok: true, ignored: "no order id" });
  }

  try {
    const outcome = await withTransaction(async (runner) => {
      /*
        Claimed FIRST, in the same transaction as the work. A duplicate
        delivery gets no claim, does nothing, and is acknowledged - which is
        what a retry is supposed to be.
      */
      const claim = await claimWebhookEvent(runner, event.eventId, event.type);
      if (!claim.isFirstDelivery) return "duplicate" as const;

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
      if (event.outcome === "unpaid") return "awaiting_payment" as const;

      const settled: SettlementOutcome =
        event.outcome === "paid"
          ? await settlePaidOrder(runner, {
              orderId: event.orderId ?? "",
              slotHoldId: event.slotHoldId,
              // Checked against the order rather than trusted. A verified
              // signature proves the event is from the processor, not that it
              // is about this order or for the right amount.
              checkoutSessionId: event.checkoutSessionId,
              paidAmountFils: event.amountFils,
              paidCurrency: event.currency,
              now: new Date(),
            })
          : await releaseFailedOrder(runner, {
              orderId: event.orderId ?? "",
              slotHoldId: event.slotHoldId,
              now: new Date(),
            });

      await markWebhookProcessed(runner, event.eventId);
      return settled;
    });

    await reportOutcome(outcome, event.eventId, event.orderId, event.type);
    return NextResponse.json({ ok: true, outcome });
  } catch (error) {
    /*
      A genuine failure - the database was unreachable, say. 500 so the
      processor RETRIES, which is what we want: the claim was rolled back with
      everything else, so the retry starts cleanly rather than seeing a claim
      for work that never happened.
    */
    logger.error("a stripe webhook could not be settled", {
      eventId: event.eventId,
      error: (error as Error).message,
    });
    return NextResponse.json({ error: "Could not settle" }, { status: 500 });
  }
}

/**
 * Say what happened, and shout about the one case that needs a human.
 *
 * Every branch here answers 2xx to the processor. None of these are things a
 * retry can improve, and a delivery retried forever buries the ones that
 * genuinely failed.
 */
async function reportOutcome(
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

    case "duplicate":
      await recordAudit({
        action: "webhook.duplicate_ignored",
        actor: { kind: "provider", provider: "stripe" },
        subject: `order:${orderId}`,
        metadata: { eventId },
      });
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
      logger.error("a payment event did not match the order it named", {
        orderId,
        eventId,
        eventType,
      });
      return;

    case "refused":
      logger.error("a payment event was refused by the state machine", {
        orderId,
        eventId,
        eventType,
      });
      return;

    case "unknown_order":
      // Verified by signature, so it really came from the processor - and yet
      // names an order we have never written. Worth knowing about.
      logger.error("a verified payment event named an order we do not have", { orderId, eventId });
      return;
  }
}
