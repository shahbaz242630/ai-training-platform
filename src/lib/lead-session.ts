import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";

/**
 * Who the browser said it was, without the browser ever holding the answer.
 *
 * When somebody enters their details we get back a customer id and an intake
 * id. Those must reach checkout, and the obvious route - handing them to the
 * browser and taking them back on the next call - means a caller can send
 * somebody else id instead. The blast radius is small (they would be paying
 * for a session booked in another name) but there is no reason to accept it.
 *
 * So the pair lives in an httpOnly cookie. Nothing in the page can read it,
 * and nothing in the page has to.
 *
 * The cookie is NOT a security token on its own - a determined person can
 * still edit it in developer tools. What makes it hold up is the check at the
 * other end: the intake must genuinely belong to the customer, so a forgery
 * needs both ids AND their relationship, not one lucky guess. The owner key is
 * different: it is random and never shown, so only the browser that was given
 * it can act on the holds it took.
 */

const COOKIE_NAME = "lead";

/**
 * Long enough to finish a booking that was interrupted by a phone call, short
 * enough that a shared machine does not hand the next person a stranger
 * details. Booking is a single sitting; this is not a login.
 */
const MAX_AGE_SECONDS = 2 * 60 * 60;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface LeadSession {
  readonly customerId: string;
  readonly intakeId: string;
  /**
   * A random key for this browser, kept across new details on the same
   * browser. A slot hold records it, and only a checkout carrying the same key
   * may give that hold back: the customer id comes from a typed email, which
   * anyone can type (security audit, 2026-10-17). Unlike the two ids, nothing
   * can be looked up to forge it.
   */
  readonly ownerKey: string;
}

/** Three ids and two separators. No name, no email, nothing worth reading. */
export function encodeLeadSession(session: LeadSession): string {
  return `${session.customerId}.${session.intakeId}.${session.ownerKey}`;
}

/**
 * Parsed strictly. Anything that is not exactly three UUIDs is discarded
 * rather than passed along to become a database lookup on attacker-chosen
 * text. A cookie from before the owner key (two parts) is refused too, so that
 * visitor enters their details again and is given a key.
 */
export function decodeLeadSession(value: string | undefined): LeadSession | null {
  if (value === undefined) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;

  const [customerId, intakeId, ownerKey] = parts;
  if (customerId === undefined || intakeId === undefined || ownerKey === undefined) return null;
  if (!UUID.test(customerId) || !UUID.test(intakeId) || !UUID.test(ownerKey)) return null;

  return { customerId, intakeId, ownerKey };
}

/** A fresh, unguessable owner key. */
export function newOwnerKey(): string {
  return randomUUID();
}

/**
 * The owner key this browser already has, or a fresh one. Entering the details
 * again (the Edit button) makes a new intake but is still the same browser, so
 * its earlier hold must stay its own to give back.
 */
export async function currentOwnerKey(): Promise<string> {
  return (await readLeadSession())?.ownerKey ?? newOwnerKey();
}

export async function writeLeadSession(session: LeadSession, isProduction: boolean): Promise<void> {
  const jar = await cookies();
  jar.set(COOKIE_NAME, encodeLeadSession(session), {
    httpOnly: true,
    sameSite: "lax",
    /*
      Derived from NODE_ENV by the caller, not from a variable somebody sets by
      hand per deployment. It used to come from NEXT_PUBLIC_SITE_ENV, which
      DEFAULTS to "development" - so a production deploy that forgot it, or
      blank-set it, shipped this cookie without Secure, with no build error and
      no runtime warning. A security flag must not have its insecure branch as
      the default of a manual step.
    */
    secure: isProduction,
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function readLeadSession(): Promise<LeadSession | null> {
  const jar = await cookies();
  return decodeLeadSession(jar.get(COOKIE_NAME)?.value);
}
