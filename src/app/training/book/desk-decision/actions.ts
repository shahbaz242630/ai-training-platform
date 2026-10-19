"use server";

import { headers } from "next/headers";
import { withTransaction } from "@/data/db";
import { recordAudit } from "@/lib/audit";
import { limitKeyFrom } from "@/lib/client-address";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createRateLimiter } from "@/lib/rate-limit";
import { confirmDecline, type DeskNoticeView, type DeskResult } from "./flow";

/*
  Ten presses a minute per address: the desk presses once. The link is useless
  without its signature, so there is nothing to guess.
*/
const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

export async function declineWithdrawalAction(
  token: unknown,
): Promise<DeskResult<{ view: DeskNoticeView }>> {
  const address = limitKeyFrom((await headers()).get("x-forwarded-for"));
  const rate = limiter.check(address, new Date());
  if (!rate.allowed) {
    return {
      ok: false,
      message: `Too many attempts. Try again in ${rate.retryAfterSeconds} seconds.`,
    };
  }
  const secret = serverEnv().MANAGE_LINK_SECRET;
  if (!secret) {
    logger.error("MANAGE_LINK_SECRET is not set, so a withdrawal cannot be declined from its link");
    return { ok: false, message: "Something went wrong on our side. Please try again later." };
  }
  try {
    const result = await confirmDecline(token, {
      transaction: withTransaction,
      now: new Date(),
      secret,
    });
    if (result.ok && result.newlyDeclined) {
      await recordAudit({
        action: "admin.action",
        actor: { kind: "system", process: "desk-decline-link" },
        subject: `booking:${result.bookingId}`,
        metadata: { reason: "withdrawal_declined_by_desk" },
      });
      logger.info("a withdrawal was declined by the desk; the booking stands", {
        bookingId: result.bookingId,
      });
    }
    return result.ok ? { ok: true, view: result.view } : result;
  } catch (error) {
    logger.error("declining a withdrawal failed", { error: (error as Error).name });
    return {
      ok: false,
      message: "Something went wrong on our side. Please try again in a moment.",
    };
  }
}
