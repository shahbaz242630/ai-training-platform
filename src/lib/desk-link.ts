import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The link in a desk alert that records the desk's decline of a withdrawal.
 *
 * It travels only to the booking desk's inbox. It names one booking, one
 * action and an expiry, signed with the server secret the manage links use,
 * but over a different body: a customer's manage link can never be read as a
 * desk link, nor a desk link as a manage link, because neither signature
 * covers the other's words.
 *
 * Opening the link changes nothing (mail scanners open links); the page it
 * leads to asks for one press of a button, and that press is the decision.
 *
 * Format: d1.<booking id>.<expiry, unix seconds>.<HMAC-SHA256, base64url>
 */

const VERSION = "d1";
/** What the signature covers besides the fields: the one action this link can take. */
const PURPOSE = "withdrawal-decline";
const MIN_SECRET_LENGTH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface DeskTokenInput {
  readonly bookingId: string;
  readonly expiresAt: Date;
}

export function createDeclineToken(input: DeskTokenInput, secret: string): string {
  assertSecret(secret);
  const expiry = String(Math.floor(input.expiresAt.getTime() / 1000));
  const fields = `${VERSION}.${input.bookingId}.${expiry}`;
  return `${fields}.${sign(fields, secret)}`;
}

/** The booking a decline token was made for, or null if it is not a valid, unexpired one. */
export function readDeclineToken(token: string, now: Date, secret: string): string | null {
  assertSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [version, bookingId, expiry, signature] = parts as [string, string, string, string];
  if (version !== VERSION || !UUID.test(bookingId) || !/^\d{1,12}$/.test(expiry)) return null;

  const expected = Buffer.from(sign(`${version}.${bookingId}.${expiry}`, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  if (now.getTime() >= Number(expiry) * 1000) return null;
  return bookingId;
}

function sign(fields: string, secret: string): string {
  return createHmac("sha256", secret).update(`${PURPOSE}:${fields}`).digest("base64url");
}

function assertSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`the desk-link secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
}
