"use server";

import { headers } from "next/headers";
import { after } from "next/server";
import { withTransaction } from "@/data/db";
import { getEmailProvider } from "@/domain/messaging/factory";
import { getSchedulingProvider } from "@/domain/scheduling/factory";
import { clientAddressFrom } from "@/lib/client-address";
import { clientEnv, serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createRateLimiter } from "@/lib/rate-limit";
import { offeredSlots } from "../[slug]/availability";
import { MESSAGES, confirmMove, type FlowResult } from "./flow";
import { REQUEST_RECEIVED, parseManageRequest, sendManageLinks } from "./request";

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

/*
  "Manage my booking" by email address. Two limits: per network address, so a
  script cannot sweep through addresses, and per inbox, so nobody can fill
  someone else's inbox with links. The inbox limit counts only emails really
  sent and is applied after the response, so it never tells anyone whether an
  address has booked, and requests from a stranger cannot lock the owner out
  (any sends they trigger deliver links to the owner).
*/
const requestLimiter = createRateLimiter({ limit: 5, windowMs: 10 * 60_000 });
const inboxLimiter = createRateLimiter({ limit: 3, windowMs: 60 * 60_000 });

export async function requestManageLinkAction(
  input: unknown,
): Promise<FlowResult<{ readonly message: string }>> {
  const now = new Date();
  const address = clientAddressFrom((await headers()).get("x-forwarded-for"));
  const rate = requestLimiter.check(address, now);
  if (!rate.allowed) {
    return {
      ok: false,
      message: `Too many requests. Please try again in ${rate.retryAfterSeconds} seconds.`,
    };
  }

  const parsed = parseManageRequest(input);
  if (!parsed.ok) return parsed;
  const { request } = parsed;

  const secret = serverEnv().MANAGE_LINK_SECRET;
  if (!secret) {
    logger.error("MANAGE_LINK_SECRET is not set, so no Manage my booking link can be sent");
    return { ok: false, message: MESSAGES.BROKEN };
  }

  /*
    After the response, so the answer takes the same time whether or not
    anything is found and sent. The outcome is logged without the address.
  */
  after(async () => {
    try {
      const provider = getEmailProvider();
      const outcome = await sendManageLinks(request, {
        transaction: withTransaction,
        now,
        secret,
        siteUrl: clientEnv.NEXT_PUBLIC_SITE_URL,
        send: (message) => provider.send(message),
        mayEmail: (email) => inboxLimiter.check(email, now).allowed,
      });
      if (outcome === "not_sent") logger.error("a Manage my booking email could not be sent");
      else logger.info("Manage my booking request handled", { outcome });
    } catch (error) {
      // The type only: a provider's or the database's message can echo an address.
      logger.error("a Manage my booking request failed", {
        error: (error as Error).name,
        code: (error as { code?: unknown }).code ?? null,
      });
    }
  });

  return { ok: true, message: REQUEST_RECEIVED };
}
