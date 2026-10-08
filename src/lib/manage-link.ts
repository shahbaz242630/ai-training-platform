import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The link that lets a customer manage their own booking without an account.
 *
 * It travels only to the inbox the booking was made with, so holding it is
 * the proof of identity - the same idea as a "reset your password" email.
 * It names one booking and an expiry, signed with a server secret; anything
 * edited, expired or signed with another secret reads as nothing. There is no
 * database row behind it, so there is nothing to look up and nothing to leak:
 * the secret is the only thing that can make one.
 *
 * Format: v1.<booking id>.<expiry, unix seconds>.<HMAC-SHA256, base64url>
 */

const VERSION = "v1";
const MIN_SECRET_LENGTH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ManageTokenInput {
  readonly bookingId: string;
  readonly expiresAt: Date;
}

export function createManageToken(input: ManageTokenInput, secret: string): string {
  assertSecret(secret);
  const expiry = String(Math.floor(input.expiresAt.getTime() / 1000));
  const body = `${VERSION}.${input.bookingId}.${expiry}`;
  return `${body}.${sign(body, secret)}`;
}

/** The booking a token was made for, or null if it is not a valid, unexpired token. */
export function readManageToken(token: string, now: Date, secret: string): string | null {
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

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function assertSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`the manage-link secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
}
