import { TERMS_PDF_2026_10_08 } from "./terms-2026-10-08.generated";

/**
 * The printed terms for each terms version, so the payment email attaches
 * exactly what the customer agreed to - not whatever the website says today.
 * A web page can change after somebody pays; this copy cannot.
 *
 * Add a line here (and run scripts/embed-terms-pdf.mjs) every time
 * TERMS_VERSION moves. A test refuses a TERMS_VERSION without a PDF.
 */
const TERMS_PDFS: ReadonlyMap<string, string> = new Map([["2026-10-08", TERMS_PDF_2026_10_08]]);

/** The PDF, base64-encoded, for a terms version; null if none was printed for it. */
export function termsPdfFor(termsVersion: string): string | null {
  return TERMS_PDFS.get(termsVersion) ?? null;
}

export function termsPdfName(termsVersion: string): string {
  return `Zaaheen-Knowledge-Centre-Terms-${termsVersion}.pdf`;
}
