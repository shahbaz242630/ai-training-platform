import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The links in our emails that confirm or stop occasional emails about new
 * sessions, without an account.
 *
 * Like the booking link, holding one is the proof: it reaches only the inbox
 * it was sent to. It names one customer by their random id (never the email
 * address) and what it may do, signed with the server's link secret. A link
 * for one purpose never works for the other, and never as a booking link: the
 * signed text starts with a label of its own, and the shape differs.
 *
 * It does not expire. An unsubscribe link must still work in an email opened
 * months later, and both actions are harmless to repeat.
 *
 * Format: e1.<purpose>.<customer id>.<HMAC-SHA256, base64url>
 */

export type EmailLinkPurpose = "confirm" | "unsubscribe";

const VERSION = "e1";
/** Keeps these signatures apart from every other use of the same secret. */
const LABEL = "zaaheen-email-link";
const MIN_SECRET_LENGTH = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PURPOSES: ReadonlySet<string> = new Set<EmailLinkPurpose>(["confirm", "unsubscribe"]);

export interface EmailLinkInput {
  readonly purpose: EmailLinkPurpose;
  readonly customerId: string;
}

export function createEmailLinkToken(input: EmailLinkInput, secret: string): string {
  assertSecret(secret);
  const body = `${VERSION}.${input.purpose}.${input.customerId}`;
  return `${body}.${sign(body, secret)}`;
}

/** The customer a link was made for, or null unless it is valid for this purpose. */
export function readEmailLinkToken(
  token: string,
  purpose: EmailLinkPurpose,
  secret: string,
): string | null {
  assertSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [version, given, customerId, signature] = parts as [string, string, string, string];
  if (version !== VERSION || given !== purpose || !PURPOSES.has(given)) return null;
  if (!UUID.test(customerId)) return null;

  const expected = Buffer.from(sign(`${version}.${given}.${customerId}`, secret));
  const presented = Buffer.from(signature);
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
  return customerId;
}

function sign(body: string, secret: string): string {
  return createHmac("sha256", secret).update(`${LABEL}:${body}`).digest("base64url");
}

function assertSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`the link secret must be at least ${MIN_SECRET_LENGTH} characters`);
  }
}
