import { randomUUID } from "node:crypto";
import { z } from "zod";
import { containsPlaceholder, renderManageLinkEmail } from "@/components/emails/templates";
import { TRAINING_BASE } from "@/config/site";
import { getSessionBySlug } from "@/config/sessions";
import { findUpcomingBookingsForEmail } from "@/data/manage-requests";
import { bookingReference, normaliseReference } from "@/domain/booking/withdrawal";
import type { EmailMessage, SendResult } from "@/domain/messaging/provider";
import { createManageToken } from "@/lib/manage-link";
import { addMinutes } from "@/lib/time";
import type { FlowResult, TransactionRunner } from "./flow";

/**
 * "Manage my booking" without the email: the customer types the address they
 * booked with (and, if they have it, the reference), and a fresh link to each
 * upcoming booking is emailed to that address.
 *
 * The page never says whether anything was found. It gives the same answer
 * for every well-formed request and sends the email after the response, so
 * neither the words nor the time taken tell a stranger whether an address
 * has booked. Only the inbox's owner ever sees a link.
 */

/** Long enough to read the email and choose a time; short enough that an old email is no key. */
export const LINK_MINUTES = 60;

export const requestFormSchema = z
  .object({
    email: z.string().trim().max(320).email("Please enter the email address you booked with."),
    reference: z.string().max(40),
  })
  .strict();

export interface ManageRequest {
  readonly email: string;
  /** Normalised, or null when none was given. */
  readonly reference: string | null;
}

/** Only the form's shape is judged here; nothing about whether bookings exist. */
export function parseManageRequest(
  input: unknown,
): FlowResult<{ readonly request: ManageRequest }> {
  const parsed = requestFormSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Please check the details and try again.",
    };
  }
  const typed = parsed.data.reference.trim();
  if (typed === "") {
    return { ok: true, request: { email: parsed.data.email.toLowerCase(), reference: null } };
  }
  const reference = normaliseReference(typed);
  if (reference === null) {
    return {
      ok: false,
      message: "That does not look like a booking reference: 8 letters and numbers.",
    };
  }
  return { ok: true, request: { email: parsed.data.email.toLowerCase(), reference } };
}

export const REQUEST_RECEIVED =
  "If there is an upcoming booking under that address, we have emailed you a link to manage it. It works for one hour. Please check your spam folder too.";

export interface ManageRequestDeps {
  readonly transaction: TransactionRunner;
  readonly now: Date;
  readonly secret: string;
  readonly siteUrl: string;
  readonly send: (message: EmailMessage) => Promise<SendResult>;
  /**
   * Asked only when there is something to send: whether this inbox may get
   * another email now. Counting only real sends means requests for an address
   * cannot lock its owner out - if they trigger sends, the owner gets links.
   */
  readonly mayEmail: (email: string) => boolean;
}

export type ManageRequestOutcome = "sent" | "nothing_found" | "not_sent" | "inbox_limit";

export async function sendManageLinks(
  request: ManageRequest,
  deps: ManageRequestDeps,
): Promise<ManageRequestOutcome> {
  const found = await deps.transaction((runner) =>
    findUpcomingBookingsForEmail(runner, {
      email: request.email,
      reference: request.reference,
      now: deps.now,
    }),
  );
  const bookings = found.flatMap((b) => {
    const session = getSessionBySlug(b.sessionSlug);
    return session ? [{ ...b, sessionTitle: session.title }] : [];
  });
  const first = bookings[0];
  if (!first) return "nothing_found";
  if (!deps.mayEmail(request.email)) return "inbox_limit";

  const expiresAt = addMinutes(deps.now, LINK_MINUTES);
  const email = await renderManageLinkEmail({
    firstName: first.firstName,
    linkMinutes: LINK_MINUTES,
    bookings: bookings.map((b) => ({
      sessionTitle: b.sessionTitle,
      start: b.scheduledStart,
      timeZone: b.customerTimezone,
      reference: bookingReference(b.bookingId),
      manageUrl: `${deps.siteUrl}${TRAINING_BASE}/book/manage?t=${createManageToken(
        { bookingId: b.bookingId, expiresAt },
        deps.secret,
      )}`,
    })),
  });
  // An identity placeholder in a customer's inbox would be worse than no email.
  if (containsPlaceholder(email)) return "not_sent";

  const result = await deps.send({
    to: request.email,
    subject: email.subject,
    html: email.html,
    text: email.text,
    idempotencyKey: `manage-link:${randomUUID()}`,
  });
  return result.ok ? "sent" : "not_sent";
}
