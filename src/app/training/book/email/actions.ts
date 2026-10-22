"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { TRAINING_BASE } from "@/config/site";
import { withTransaction } from "@/data/db";
import { recordAudit } from "@/lib/audit";
import { limitKeyFrom } from "@/lib/client-address";
import { serverEnv } from "@/lib/env";
import type { EmailLinkPurpose } from "@/lib/email-link";
import { logger } from "@/lib/logger";
import { createRateLimiter } from "@/lib/rate-limit";
import { actOnEmailLink } from "./flow";

/*
  Ten presses a minute per address: far more than anybody needs to press one
  button, far too few to be a way of trying links.
*/
const limiter = createRateLimiter({ limit: 10, windowMs: 60_000 });

export type LinkOutcome = "done" | "invalid" | "busy" | "error";

const PAGES: Readonly<Record<EmailLinkPurpose, string>> = {
  confirm: `${TRAINING_BASE}/book/email/confirm`,
  unsubscribe: `${TRAINING_BASE}/book/email/unsubscribe`,
};

async function act(purpose: EmailLinkPurpose, form: FormData): Promise<LinkOutcome> {
  const address = limitKeyFrom((await headers()).get("x-forwarded-for"));
  if (!limiter.check(address, new Date()).allowed) return "busy";
  try {
    const result = await actOnEmailLink(
      purpose,
      { token: form.get("token") },
      {
        transaction: withTransaction,
        now: new Date(),
        secret: serverEnv().MANAGE_LINK_SECRET ?? null,
      },
    );
    if (!result.ok) return "invalid";
    if (result.changed) {
      // The record that the person behind the address asked for this themselves.
      await recordAudit({
        action: purpose === "confirm" ? "customer.marketing_confirmed" : "customer.unsubscribed",
        // Pressed by whoever holds the link sent to the address: the owner.
        actor: { kind: "customer", customerId: result.customerId },
        subject: `customer:${result.customerId}`,
        metadata: { via: "email-link" },
      });
    }
    return "done";
  } catch (error) {
    logger.error("an email link could not be acted on", {
      purpose,
      error: (error as Error).name,
    });
    return "error";
  }
}

/*
  Each ends by loading its page again with the outcome, never the link: the
  page then shows a plain answer and nothing that could be pressed twice.
*/
export async function confirmEmailsAction(form: FormData): Promise<void> {
  const outcome = await act("confirm", form);
  redirect(`${PAGES.confirm}?outcome=${outcome}`);
}

export async function unsubscribeAction(form: FormData): Promise<void> {
  const outcome = await act("unsubscribe", form);
  redirect(`${PAGES.unsubscribe}?outcome=${outcome}`);
}
