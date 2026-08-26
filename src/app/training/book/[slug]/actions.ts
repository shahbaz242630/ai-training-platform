"use server";

import { headers } from "next/headers";
import { captureLead } from "@/data/customers";
import { withTransaction } from "@/data/db";
import { parsePrePaymentIntake, type IntakeFieldError } from "@/domain/intake/pre-payment-intake";
import { createRateLimiter } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

/**
 * Capturing somebody's details when they start a booking.
 *
 * THIS is the security boundary, not the form. The panel validates as a
 * courtesy to the person filling it in; a browser can be told anything, so
 * everything is validated again here before it reaches the database.
 */

/*
  Five attempts a minute per address. Generous for somebody correcting a typo,
  useless for filling the customers table or probing which emails already
  exist. Module scope so the counts survive between requests within an
  instance - see the limits documented in lib/rate-limit.
*/
const limiter = createRateLimiter({ limit: 5, windowMs: 60_000 });

export interface CaptureLeadResult {
  readonly ok: boolean;
  readonly errors?: readonly IntakeFieldError[];
  /** Present only on success. Nothing identifying: an internal id and nothing else. */
  readonly customerId?: string;
}

/**
 * The caller's address, for rate limiting only.
 *
 * Behind a proxy the socket address is the proxy, so x-forwarded-for is read -
 * with the FIRST entry taken, since a client can append its own values and
 * everything after the first is unverifiable. Falls back to a shared bucket
 * rather than to "no limit": an unknown caller should be limited more, not
 * less.
 */
async function callerKey(): Promise<string> {
  const headerList = await headers();
  const forwarded = headerList.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}

export async function captureLeadAction(input: unknown): Promise<CaptureLeadResult> {
  const rate = limiter.check(await callerKey(), new Date());
  if (!rate.allowed) {
    return {
      ok: false,
      errors: [
        {
          field: "form",
          message: `Too many attempts. Please try again in ${rate.retryAfterSeconds} seconds.`,
        },
      ],
    };
  }

  // Validated here rather than trusted from the browser. The strict schema
  // also refuses any field it was not asked for.
  const parsed = parsePrePaymentIntake(input);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  try {
    const captured = await withTransaction((runner) =>
      captureLead(runner, parsed.value, new Date()),
    );

    /*
      No email address, name or goal in the log line. Knowing that a lead was
      captured is operationally useful; copying somebody's personal details
      into a log file is how personal data ends up somewhere nobody is
      protecting.
    */
    logger.info("lead captured", {
      customerId: captured.customerId,
      isNewCustomer: captured.isNewCustomer,
    });

    return { ok: true, customerId: captured.customerId };
  } catch (error) {
    logger.error("lead capture failed", { error: (error as Error).message });
    return {
      ok: false,
      errors: [
        {
          field: "form",
          message: "We could not save your details. Please try again in a moment.",
        },
      ],
    };
  }
}
