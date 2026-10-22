import { createHash } from "node:crypto";
import type { QueryRunner } from "./db";
import {
  AGREEMENT_TEXT,
  EXPRESS_REQUEST_TEXT,
  KEY_TERMS,
  TERMS_VERSION,
} from "@/config/booking-terms";

/**
 * The customer's agreement, stored with the pending order.
 *
 * The texts are the server's own constants, never anything the browser sent:
 * the record must say what the page showed, and a browser can be told to
 * claim anything. The hash lets a later copy be proven unaltered.
 */
export interface ConsentInput {
  readonly orderId: string;
  readonly withinCancellationPeriod: boolean;
  readonly expressRequest: boolean;
  /**
   * The prerequisites the booking page showed, one per line, from the
   * catalogue. Checkout refuses a booking whose box was not ticked, so a
   * stored text always means the customer confirmed reading it.
   */
  readonly prerequisitesText: string;
  readonly acceptedAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/**
 * The texts as stored, and the hash that seals them. Exported for tests.
 * Without prerequisites the hash is the one sealed before they were asked
 * for (2026-10-22), so the records written then can still be checked.
 */
export function consentTexts(
  withinCancellationPeriod: boolean,
  prerequisitesText?: string,
): {
  keyTerms: string;
  agreementText: string;
  expressRequestText: string | null;
  sha256: string;
} {
  const keyTerms = KEY_TERMS.join("\n");
  const expressRequestText = withinCancellationPeriod ? EXPRESS_REQUEST_TEXT : null;
  const parts = [TERMS_VERSION, keyTerms, AGREEMENT_TEXT, expressRequestText ?? ""];
  if (prerequisitesText !== undefined) parts.push(prerequisitesText);
  const sha256 = createHash("sha256").update(parts.join("\u0000")).digest("hex");
  return { keyTerms, agreementText: AGREEMENT_TEXT, expressRequestText, sha256 };
}

export async function recordBookingConsent(
  runner: QueryRunner,
  input: ConsentInput,
): Promise<void> {
  const texts = consentTexts(input.withinCancellationPeriod, input.prerequisitesText);
  await runner.query(
    `insert into booking_consents
       (order_id, terms_version, key_terms, agreement_text, express_request_text,
        within_cancellation_period, express_request, text_sha256, accepted_at,
        ip_address, user_agent, prerequisites_text, prerequisites_confirmed)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, true)`,
    [
      input.orderId,
      TERMS_VERSION,
      texts.keyTerms,
      texts.agreementText,
      texts.expressRequestText,
      input.withinCancellationPeriod,
      input.expressRequest,
      texts.sha256,
      input.acceptedAt,
      input.ipAddress,
      input.userAgent === null ? null : input.userAgent.slice(0, 500),
      input.prerequisitesText,
    ],
  );
}
