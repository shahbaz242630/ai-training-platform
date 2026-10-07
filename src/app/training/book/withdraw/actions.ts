"use server";

import { headers } from "next/headers";
import { withTransaction } from "@/data/db";
import { recordAudit } from "@/lib/audit";
import { clientAddressFrom } from "@/lib/client-address";
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

async function limited(): Promise<string | null> {
  const address = clientAddressFrom((await headers()).get("x-forwarded-for"));
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
    return await lookUpWithdrawal(input, { transaction: withTransaction, now: new Date() });
  } catch (error) {
    logger.error("withdrawal lookup failed", { error: (error as Error).message });
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
    const result = await confirmWithdrawal(
      input,
      { transaction: withTransaction, now: new Date() },
      {
        ipAddress: clientAddressFrom(headerList.get("x-forwarded-for")),
        userAgent: headerList.get("user-agent"),
      },
    );
    if (!result.ok) return result;

    if (result.receipt.isNew) {
      await recordAudit({
        action: "booking.cancelled",
        actor: { kind: "system", process: "withdrawal-form" },
        subject: `booking:${result.bookingId}`,
        metadata: { reason: "customer_withdrawal" },
      });
      // No name or email here: the booking id is enough to find everything.
      logger.warn("withdrawal received: take the session off the calendar and refund by hand", {
        bookingId: result.bookingId,
      });
    }
    return { ok: true, receipt: result.receipt };
  } catch (error) {
    logger.error("withdrawal could not be recorded", { error: (error as Error).message });
    return {
      ok: false,
      message: "Something went wrong on our side. Please try again in a moment.",
    };
  }
}
