"use server";

import { headers } from "next/headers";
import { withTransaction } from "@/data/db";
import { getSchedulingProvider } from "@/domain/scheduling/factory";
import { clientAddressFrom } from "@/lib/client-address";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createRateLimiter } from "@/lib/rate-limit";
import { offeredSlots } from "../[slug]/availability";
import { MESSAGES, confirmMove, type FlowResult } from "./flow";

/*
  Ten tries a minute per address. A customer choosing a time needs one or
  two; a link is useless without its signature, so there is nothing here to
  guess, but the move reads the live calendar and that is worth protecting.
*/
const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

export async function moveBookingAction(
  input: unknown,
): Promise<FlowResult<{ readonly newTime: string }>> {
  const address = clientAddressFrom((await headers()).get("x-forwarded-for"));
  const rate = limiter.check(address, new Date());
  if (!rate.allowed) {
    return {
      ok: false,
      message: `Too many attempts. Please try again in ${rate.retryAfterSeconds} seconds.`,
    };
  }

  const secret = serverEnv().MANAGE_LINK_SECRET;
  if (!secret) {
    logger.error("MANAGE_LINK_SECRET is not set, so no booking can be moved online");
    return { ok: false, message: MESSAGES.BROKEN };
  }

  try {
    return await confirmMove(input, {
      transaction: withTransaction,
      now: new Date(),
      secret,
      offered: offeredSlots,
      calendar: getSchedulingProvider(),
    });
  } catch (error) {
    logger.error("moving a booking failed", { error: (error as Error).message });
    return { ok: false, message: MESSAGES.BROKEN };
  }
}
