"use server";

import { headers } from "next/headers";
import { captureLead } from "@/data/customers";
import { withTransaction } from "@/data/db";
import { parsePrePaymentIntake, type IntakeFieldError } from "@/domain/intake/pre-payment-intake";
import { createRateLimiter } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";
import { holdSlot } from "@/data/slot-holds";
import { getSessionBySlug } from "@/config/sessions";
import { DEFAULT_HOLD_TTL_MINUTES } from "@/domain/booking/slot-hold";
import {
  holdInterval,
  isOfferedSlot,
  reserveSlotRequestSchema,
  type ReserveSlotRefusal,
} from "@/domain/booking/reserve-slot";
import { addMinutes } from "@/lib/time";
import { offeredSlots } from "./availability";

/**
 * One message for every way a slot can turn out to be unbookable.
 *
 * A customer does not benefit from knowing whether they lost a race by two
 * milliseconds or asked for a time that was never offered - both mean "pick
 * another one", and distinguishing them out loud only tells somebody probing
 * the endpoint which of their guesses was closer.
 */
const SLOT_GONE_MESSAGE = "Sorry - that time has just been taken. Please choose another.";

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

/*
  Reserving is limited harder than lead capture, and for a different reason.
  A lead is a row; a hold takes a sellable time slot off the calendar for
  fifteen minutes. Somebody looping this endpoint could occupy the whole week
  without ever paying, which is a denial of service against our own diary
  rather than against a server.
*/
const reserveLimiter = createRateLimiter({ limit: 6, windowMs: 60_000 });

export interface ReserveSlotResult {
  readonly ok: boolean;
  /** Present only on success. The claim checkout will convert once payment is verified. */
  readonly holdId?: string;
  /** UTC ISO. What the customer is told they have until. */
  readonly expiresAt?: string;
  readonly reason?: ReserveSlotRefusal | "rate_limited" | "failed";
  readonly message?: string;
  /**
   * Availability as it stands AFTER the refusal, so a customer who lost a race
   * is shown what is actually left rather than the list that just failed them.
   */
  readonly slotStarts?: readonly string[];
}

/**
 * Claim a time slot at the moment checkout begins.
 *
 * NOT when a radio button is clicked. Somebody comparing four times would
 * otherwise take four slots off the calendar for fifteen minutes each, having
 * paid for none of them.
 *
 * The database settles the race, not this function. Two customers can arrive
 * in the same millisecond and both pass every check above the insert; the
 * exclusion constraint is what makes exactly one of them win.
 */
export async function reserveSlotAction(input: unknown): Promise<ReserveSlotResult> {
  const rate = reserveLimiter.check(await callerKey(), new Date());
  if (!rate.allowed) {
    return {
      ok: false,
      reason: "rate_limited",
      message: `Too many attempts. Please try again in ${rate.retryAfterSeconds} seconds.`,
    };
  }

  const parsed = reserveSlotRequestSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: "not_offered", message: SLOT_GONE_MESSAGE };
  }

  const session = getSessionBySlug(parsed.data.slug);
  if (!session || !session.active) {
    return { ok: false, reason: "not_offered", message: SLOT_GONE_MESSAGE };
  }

  const now = new Date();
  const requested = new Date(parsed.data.slotStart);

  try {
    const offered = await offeredSlots(session.durationMinutes, now);

    /*
      Re-derived on the server and never taken from the request. A crafted
      payload asking for 03:00 on a Sunday is refused here, because that
      instant is not in the list we generated - checking only that nothing
      clashes would let it through, since nothing clashes at 03:00.
    */
    if (!isOfferedSlot(requested, offered)) {
      return {
        ok: false,
        reason: "not_offered",
        message: SLOT_GONE_MESSAGE,
        slotStarts: offered.map((slot) => slot.start.toISOString()),
      };
    }

    const interval = holdInterval(requested, session.durationMinutes);
    const outcome = await holdSlot({
      slotStart: interval.start,
      slotEnd: interval.end,
      expiresAt: addMinutes(now, DEFAULT_HOLD_TTL_MINUTES),
      /*
        No order exists yet - the order is created when checkout starts, and
        the hold is what stops the slot being sold while that happens.

        calendarEventId stays null on purpose. The tentative Outlook event
        belongs here, but the scheduling provider is still the in-memory mock,
        so any id it produced would not survive the request. Storing a
        fabricated id would be worse than storing none: the sweep would later
        try to delete a calendar event that never existed anywhere.
      */
      orderId: null,
      calendarEventId: null,
    });

    if (!outcome.ok) {
      // A lost race is a normal outcome, so the customer is offered what is
      // left rather than shown an error they cannot act on.
      const remaining = await offeredSlots(session.durationMinutes, new Date());
      return {
        ok: false,
        reason: "slot_taken",
        message: SLOT_GONE_MESSAGE,
        slotStarts: remaining.map((slot) => slot.start.toISOString()),
      };
    }

    logger.info("slot held", {
      holdId: outcome.hold.id,
      sessionSlug: session.slug,
      slotStart: interval.start.toISOString(),
    });

    return {
      ok: true,
      holdId: outcome.hold.id,
      expiresAt: outcome.hold.expiresAt.toISOString(),
    };
  } catch (error) {
    /*
      Everything that is NOT a lost race lands here: a dropped connection, a
      missing table, an unreachable database. Reporting those as "that time has
      gone" would hide an outage behind a plausible message and send the
      customer off to pick another slot that will fail in exactly the same way.
    */
    logger.error("slot reservation failed", { error: (error as Error).message });
    return {
      ok: false,
      reason: "failed",
      message: "We could not reserve that time. Please try again in a moment.",
    };
  }
}
