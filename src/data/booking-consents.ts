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
  readonly acceptedAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

/** The texts as stored, and the hash that seals them. Exported for tests. */
export function consentTexts(withinCancellationPeriod: boolean): {
  keyTerms: string;
  agreementText: string;
  expressRequestText: string | null;
  sha256: string;
} {
  const keyTerms = KEY_TERMS.join("\n");
  const expressRequestText = withinCancellationPeriod ? EXPRESS_REQUEST_TEXT : null;
  const sha256 = createHash("sha256")
    .update([TERMS_VERSION, keyTerms, AGREEMENT_TEXT, expressRequestText ?? ""].join("\u0000"))
    .digest("hex");
  return { keyTerms, agreementText: AGREEMENT_TEXT, expressRequestText, sha256 };
}

export async function recordBookingConsent(
  runner: QueryRunner,
  input: ConsentInput,
): Promise<void> {
  const texts = consentTexts(input.withinCancellationPeriod);
  await runner.query(
    `insert into booking_consents
       (order_id, terms_version, key_terms, agreement_text, express_request_text,
        within_cancellation_period, express_request, text_sha256, accepted_at,
        ip_address, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
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
    ],
  );
}
