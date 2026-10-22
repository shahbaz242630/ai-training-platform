"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { sendQueuedMessageNow } from "@/app/api/cron/send-communications/deliver";
import { withTransaction } from "@/data/db";
import { getEmailProvider } from "@/domain/messaging/factory";
import { getPaymentProvider } from "@/domain/payments/factory";
import { recordAudit } from "@/lib/audit";
import { clientAddressFrom, limitKeyFrom } from "@/lib/client-address";
import { logger } from "@/lib/logger";
import { createRateLimiter } from "@/lib/rate-limit";
import {
  confirmWithdrawal,
  lookUpWithdrawal,
  type FlowResult,
  type WithdrawalReceipt,
  type WithdrawalSummary,
} from "./flow";

/*
  Ten tries a minute per address, shared by both steps. Enough for somebody
  correcting a typo in their reference; far too few to guess references for
  an email address, which needs both to match anyway.
*/
const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

/*
  The payment provider is built only when a card country is actually asked
  for: looking a booking up must not fail because payments are unconfigured.
*/
const flowDeps = () => ({
  transaction: withTransaction,
  now: new Date(),
  cardCountry: (paymentIntentId: string) => getPaymentProvider().getCardCountry(paymentIntentId),
});

async function limited(): Promise<string | null> {
  const address = limitKeyFrom((await headers()).get("x-forwarded-for"));
  const rate = limiter.check(address, new Date());
  return rate.allowed
    ? null
    : `Too many attempts. Please try again in ${rate.retryAfterSeconds} seconds.`;
}

export async function lookUpWithdrawalAction(
  input: unknown,
): Promise<FlowResult<{ summary: WithdrawalSummary; alreadyReceived: WithdrawalReceipt | null }>> {
  const refused = await limited();
  if (refused) return { ok: false, message: refused };
  try {
    return await lookUpWithdrawal(input, flowDeps());
  } catch (error) {
    logger.error("withdrawal lookup failed", { error: (error as Error).name });
    return {
      ok: false,
      message: "Something went wrong on our side. Please try again in a moment.",
    };
  }
}

export async function confirmWithdrawalAction(
  input: unknown,
): Promise<FlowResult<{ receipt: WithdrawalReceipt }>> {
  const refused = await limited();
  if (refused) return { ok: false, message: refused };

  const headerList = await headers();
  try {
    const result = await confirmWithdrawal(input, flowDeps(), {
      ipAddress: clientAddressFrom(headerList.get("x-forwarded-for")),
      userAgent: headerList.get("user-agent"),
    });
    if (!result.ok) return result;

    if (result.receipt.isNew && result.receipt.route === "automatic") {
      await recordAudit({
        action: "booking.cancelled",
        actor: { kind: "system", process: "withdrawal-form" },
        subject: `booking:${result.bookingId}`,
        metadata: { reason: "customer_withdrawal" },
      });
      // No name or email here: the booking id is enough to find everything.
      logger.warn(
        "withdrawal received: the refund is issued automatically; check the calendar event has gone",
        {
          bookingId: result.bookingId,
        },
      );
    } else if (result.receipt.isNew) {
      await recordAudit({
        action: "admin.action",
        actor: { kind: "system", process: "withdrawal-form" },
        subject: `booking:${result.bookingId}`,
        metadata: { reason: "withdrawal_for_desk_decision" },
      });
      logger.warn(
        "withdrawal received for the desk to decide: the card is not from the UK or the EU; the booking stays until then",
        { bookingId: result.bookingId },
      );
    }
    if (result.receipt.isNew) {
      /*
        The acknowledgement straight away, as the page promises and the law
        asks, rather than at the next five-minute run. After the response, so
        the customer is not kept waiting on the email service. It is claimed
        like any queued message, so the five-minute job cannot send it too, and
        if this send fails it stays queued for that job to send.
      */
      const bookingId = result.bookingId;
      after(async () => {
        try {
          const outcome = await sendQueuedMessageNow({
            bookingId,
            templateKey: "withdrawal_acknowledgement",
            provider: getEmailProvider(),
            now: new Date(),
          });
          logger.info("withdrawal acknowledgement sent straight away", { bookingId, outcome });
        } catch (error) {
          // The type only: a provider's or the database's message can echo an address.
          logger.error("the withdrawal acknowledgement could not be sent straight away", {
            bookingId,
            error: (error as Error).name,
          });
        }
      });
    }
    return { ok: true, receipt: result.receipt };
  } catch (error) {
    logger.error("withdrawal could not be recorded", { error: (error as Error).name });
    return {
      ok: false,
      message: "Something went wrong on our side. Please try again in a moment.",
    };
  }
}
