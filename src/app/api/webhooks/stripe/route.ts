import { NextResponse } from "next/server";
import { withTransaction } from "@/data/db";
import { claimWebhookEvent, markWebhookProcessed } from "@/data/webhook-events";
import { getPaymentProvider } from "@/domain/payments/factory";
import { InvalidSignatureError } from "@/domain/payments/provider";
import { recordAudit } from "@/lib/audit";
import { limitKeyFrom } from "@/lib/client-address";
import { createEvidenceBudget } from "@/lib/evidence-budget";
import { logger } from "@/lib/logger";
import { readTextWithin } from "@/lib/read-body";
import { applyCheckoutOutcome, confirmOnCalendar, reportOutcome } from "./checkout-outcome";
import { handleRefundEvent } from "./refund-event";

/*
  Stripe's events are a few kilobytes. The body has to be read before the
  signature can be checked, so without a cap anybody could make this public
  route read an arbitrarily large body into memory (security audit,
  2026-09-27). One mebibyte is far above any real event.
*/
const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

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

/*
  A forged delivery is worth a row in the audit trail - but only so many. This
  endpoint is public and the trail is append-only, so recording every
  rejection let anybody who could reach the URL grow that table without bound,
  having authenticated nothing. The first few rejections per source per minute
  are recorded, with a total cap that holds even when sources cannot be told
  apart. The rest are still refused and still logged. See lib/evidence-budget.
*/
const REJECTION_EVIDENCE = createEvidenceBudget({ perSource: 5, total: 60, windowMs: 60_000 });

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
    request.json() here would silently make verification meaningless. Read
    with a cap, and refused unread when over it.
  */
  const body = await readTextWithin(request, MAX_WEBHOOK_BODY_BYTES);
  if (!body.ok) {
    logger.warn("a stripe webhook body over the size cap was refused unread");
    return NextResponse.json({ error: "Too large" }, { status: 413 });
  }
  const rawBody = body.text;
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
      const source = limitKeyFrom(request.headers.get("x-forwarded-for"));
      if (REJECTION_EVIDENCE.shouldRecord(source, new Date())) {
        await recordAudit({
          action: "webhook.signature_rejected",
          actor: { kind: "provider", provider: "stripe" },
          subject: "stripe:unverified",
        });
      } else {
        logger.warn("a forged delivery was refused but not recorded: evidence budget spent");
      }
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

  // Refunds find their order their own way, so they are handled before the guards below.
  if (event.kind === "refund") return handleRefundEvent(event);

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

  const orderId = event.orderId;
  try {
    const outcome = await withTransaction(async (runner) => {
      /*
        Claimed FIRST, in the same transaction as the work. A duplicate
        delivery gets no claim, does nothing, and is acknowledged - which is
        what a retry is supposed to be.
      */
      const claim = await claimWebhookEvent(runner, event.eventId, event.type);
      if (!claim.isFirstDelivery) return "duplicate" as const;

      const outcome = await applyCheckoutOutcome(runner, { ...event, orderId }, new Date());
      await markWebhookProcessed(runner, event.eventId);
      return outcome;
    });

    await reportOutcome(outcome, event.eventId, orderId, event.type);

    /*
      AFTER the transaction, on purpose. Promoting the calendar event and
      issuing the join link talks to Microsoft, and the settlement above must
      never wait on that or be rolled back by it. If this fails, the booking
      stays scheduled and the five-minute sweep tries again; the customer's
      acknowledgement is already queued either way.
    */
    if (outcome === "settled") await confirmOnCalendar(orderId);

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
