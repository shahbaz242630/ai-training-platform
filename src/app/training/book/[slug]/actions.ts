"use server";

import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import { captureLead } from "@/data/customers";
import { withTransaction } from "@/data/db";
import { parsePrePaymentIntake, type IntakeFieldError } from "@/domain/intake/pre-payment-intake";
import { createRateLimiter } from "@/lib/rate-limit";
import { clientAddressFrom, isUsableReturnUrl } from "@/lib/client-address";
import { logger } from "@/lib/logger";
import { clientEnv, serverEnv } from "@/lib/env";
import { writeLeadSession, readLeadSession } from "@/lib/lead-session";
import { holdSlot, releaseHoldById } from "@/data/slot-holds";
import {
  attributionIdForSession,
  attachCheckoutSession,
  leadBelongsTogether,
  persistPendingOrder,
  SlotHoldNoLongerLiveError,
} from "@/data/orders";
import { getSessionBySlug } from "@/config/sessions";
import { resolvePrice } from "@/domain/pricing/resolve-price";
import { createOrder } from "@/domain/booking/order";
import { DEFAULT_HOLD_TTL_MINUTES } from "@/domain/booking/slot-hold";
import { getPaymentProvider } from "@/domain/payments/factory";
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
}

/**
 * The caller's address, for rate limiting only.
 *
 * The reasoning that used to sit here was backwards, and the code with it: it
 * took the FIRST x-forwarded-for entry on the grounds that later entries were
 * unverifiable. It is the other way round. The header is built by APPENDING,
 * so the leftmost entry is whatever the client wrote and the trustworthy ones
 * are on the right. See lib/client-address.
 */
async function callerKey(): Promise<string> {
  const headerList = await headers();
  return clientAddressFrom(headerList.get("x-forwarded-for"));
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

    /*
      The ids go into an httpOnly cookie rather than back to the browser.
      Checkout needs them, and handing them to the page means a caller can
      send somebody else id on the next call instead. Nothing on the page
      reads this, and nothing on the page needs to.
    */
    await writeLeadSession(
      { customerId: captured.customerId, intakeId: captured.intakeId },
      serverEnv().NODE_ENV === "production",
    );

    return { ok: true };
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
  Starting checkout is limited harder than lead capture. A lead is a row; this
  takes a sellable time off the calendar AND creates an order. Somebody
  looping it could occupy the whole week without paying for any of it, which
  is a denial of service against our own diary rather than against a server.
*/
const checkoutLimiter = createRateLimiter({ limit: 6, windowMs: 60_000 });

export interface StartCheckoutResult {
  readonly ok: boolean;
  /** Present only on success. Where the browser must go next. */
  readonly redirectUrl?: string;
  readonly reason?: ReserveSlotRefusal | "rate_limited" | "no_lead" | "unavailable" | "failed";
  readonly message?: string;
  /**
   * Availability as it stands AFTER a refusal, so somebody who lost a race is
   * shown what is actually left rather than the list that just failed them.
   */
  readonly slotStarts?: readonly string[];
}

/**
 * Take the slot, create the order, and hand back somewhere to pay.
 *
 * The order of operations is deliberate and each step guards the next:
 *
 *   1. hold the slot   - losing the race is the common failure, so it happens
 *                        before anything is written that would need undoing
 *   2. create the order - pending, never paid, in one transaction with its
 *                        booking and the link back to the hold
 *   3. start checkout  - and only now does the customer go anywhere
 *
 * If step 3 fails, step 1 is undone. Otherwise a failure to reach Stripe
 * would block a sellable slot for fifteen minutes for nothing.
 *
 * NOTHING here confirms a booking. The order is `pending` and the booking is
 * `awaiting_schedule` until a verified webhook says otherwise.
 */
export async function startCheckoutAction(input: unknown): Promise<StartCheckoutResult> {
  const rate = checkoutLimiter.check(await callerKey(), new Date());
  if (!rate.allowed) {
    return {
      ok: false,
      reason: "rate_limited",
      message: `Too many attempts. Please try again in ${rate.retryAfterSeconds} seconds.`,
    };
  }

  const parsed = reserveSlotRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "not_offered", message: SLOT_GONE_MESSAGE };

  const session = getSessionBySlug(parsed.data.slug);
  if (!session || !session.active) {
    return { ok: false, reason: "not_offered", message: SLOT_GONE_MESSAGE };
  }

  /*
    Read server-side from an httpOnly cookie, never from the request body. If
    it is missing the customer has not given us their details in this browser,
    and the honest answer is to send them back a step rather than to invent an
    anonymous order.
  */
  const lead = await readLeadSession();
  if (lead === null) {
    return {
      ok: false,
      reason: "no_lead",
      message: "Please enter your details again before choosing a time.",
    };
  }

  /*
    Checked BEFORE anything is written. Constructing a provider is what
    surfaces missing configuration, and doing it here means an unconfigured
    deployment never takes a slot off the calendar for a payment it cannot
    accept.
  */
  /*
    Refused BEFORE a slot is taken. A production deployment that forgot
    NEXT_PUBLIC_SITE_URL would otherwise send every paying customer back to
    http://localhost:3000 - the payment succeeds and the customer lands on a
    dead page, with nothing in the system reporting a fault.
  */
  if (!isUsableReturnUrl(clientEnv.NEXT_PUBLIC_SITE_URL, serverEnv().NODE_ENV === "production")) {
    logger.error("checkout refused: the site URL is not usable as a payment return address", {
      siteUrl: clientEnv.NEXT_PUBLIC_SITE_URL,
    });
    return {
      ok: false,
      reason: "unavailable",
      message: "Payment is not available right now. Please get in touch and we will book you in.",
    };
  }

  let payments;
  try {
    payments = getPaymentProvider();
  } catch {
    logger.error("checkout attempted while payments are not configured");
    return {
      ok: false,
      reason: "unavailable",
      message: "Payment is not available right now. Please get in touch and we will book you in.",
    };
  }

  const now = new Date();
  const requested = new Date(parsed.data.slotStart);
  let heldId: string | null = null;

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
      orderId: null,
      calendarEventId: null,
    });

    if (!outcome.ok) {
      const remaining = await offeredSlots(session.durationMinutes, new Date());
      return {
        ok: false,
        reason: "slot_taken",
        message: SLOT_GONE_MESSAGE,
        slotStarts: remaining.map((slot) => slot.start.toISOString()),
      };
    }
    heldId = outcome.hold.id;

    return await createOrderAndCheckout({
      lead,
      session,
      interval,
      holdId: outcome.hold.id,
      payments,
      now,
    });
  } catch (error) {
    // The slot goes back. A failure here must not cost a sellable time.
    if (heldId !== null) await releaseHeldSlotQuietly(heldId);

    if (error instanceof SlotHoldNoLongerLiveError) {
      return { ok: false, reason: "slot_taken", message: SLOT_GONE_MESSAGE };
    }

    logger.error("checkout could not be started", { error: (error as Error).message });
    return {
      ok: false,
      reason: "failed",
      message: "We could not start checkout. Please try again in a moment.",
    };
  }
}

/**
 * The part that writes. Split out so the guard clauses above stay readable.
 *
 * The price is resolved from the CATALOGUE by slug and never from anything
 * the browser sent. This is the single most important line in the payment
 * path: a client-supplied amount is how somebody books a session for one fil.
 */
async function createOrderAndCheckout(args: {
  lead: { customerId: string; intakeId: string };
  session: { slug: string; durationMinutes: number };
  interval: { start: Date; end: Date };
  holdId: string;
  payments: ReturnType<typeof getPaymentProvider>;
  now: Date;
}): Promise<StartCheckoutResult> {
  const price = resolvePrice("session", args.session.slug);

  const orderId = randomUUID();
  const order = createOrder({
    id: orderId,
    customerId: args.lead.customerId,
    orderType: "single",
    sessionSlug: args.session.slug,
    grossAmountFils: price.amountFils,
    currency: price.currency,
    taxRateBasisPoints: price.taxRateBasisPoints,
    intakeId: args.lead.intakeId,
    now: args.now,
  });

  const { email, attributionId } = await withTransaction(async (runner) => {
    /*
      The intake must belong to the customer. A forged cookie has to get both
      ids right AND their relationship, and a mismatch means the browser sent
      something it should not have - so this refuses rather than repairs.
    */
    if (!(await leadBelongsTogether(runner, args.lead.customerId, args.lead.intakeId))) {
      throw new Error("The lead session did not match a real customer and intake");
    }

    /*
      Email AND timezone come from the customer record, not from the request.
      The timezone is what the confirmation and the reminders will be rendered
      in, and a browser that can assert it can put somebody hours out from
      their own session.
    */
    const found = await runner.query<{ email: string; timezone: string }>(
      `select email, timezone from customers where id = $1`,
      [args.lead.customerId],
    );
    const customer = found.rows[0];
    if (!customer) throw new Error("The lead session named a customer that does not exist");

    // Best effort. A missing attribution row costs us a report line; it must
    // never cost somebody their booking.
    const attribution = await attributionIdForSession(runner, await readAttributionCookie());

    await persistPendingOrder(runner, {
      order: { ...order, attributionId: attribution },
      sessionSlug: args.session.slug,
      slotStart: args.interval.start,
      slotEnd: args.interval.end,
      customerTimezone: customer.timezone,
      slotHoldId: args.holdId,
    });

    return { email: customer.email, attributionId: attribution };
  });

  const started = await args.payments.startCheckout({
    line: {
      slug: args.session.slug,
      title: price.title,
      amountFils: price.amountFils,
      currency: price.currency,
    },
    orderId,
    customerEmail: email,
    slotHoldId: args.holdId,
    successUrl: `${clientEnv.NEXT_PUBLIC_SITE_URL}/training/book/${args.session.slug}/confirming`,
    cancelUrl: `${clientEnv.NEXT_PUBLIC_SITE_URL}/training/book/${args.session.slug}?cancelled=1`,
    /*
      Derived from the order, never random. A retry with a fresh key is not
      idempotency - it is a second checkout session and, eventually, a second
      charge.
    */
    idempotencyKey: `order:${orderId}`,
  });

  await withTransaction((runner) =>
    attachCheckoutSession(runner, orderId, started.checkoutSessionId),
  );

  logger.info("checkout started", {
    orderId,
    sessionSlug: args.session.slug,
    hasAttribution: attributionId !== null,
  });

  return { ok: true, redirectUrl: started.redirectUrl };
}

/** The attribution key for this browser, if the cookie is there. */
async function readAttributionCookie(): Promise<string | null> {
  const jar = await cookies();
  return jar.get("ats")?.value ?? null;
}

/**
 * Release a hold without letting the release itself become the error the
 * customer sees. The original failure is the one worth reporting.
 */
async function releaseHeldSlotQuietly(holdId: string): Promise<void> {
  try {
    await withTransaction((runner) => releaseHoldById(runner, holdId));
  } catch (error) {
    logger.error("a slot hold could not be released after a failed checkout", {
      holdId,
      error: (error as Error).message,
    });
  }
}
