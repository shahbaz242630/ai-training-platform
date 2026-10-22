import { z } from "zod";
import type { QueryRunner } from "@/data/db";
import { confirmMarketingConsent, unsubscribeCustomer } from "@/data/customers";
import { readEmailLinkToken, type EmailLinkPurpose } from "@/lib/email-link";

/**
 * What the two buttons behind our email links do: confirm that the owner of
 * an address wants occasional emails about new sessions, or stop them.
 *
 * Opening a link changes nothing. Mail scanners open links to check them, so
 * only pressing the button on the page, which posts the link back, acts.
 * A link that is not valid gets the same short answer whatever is wrong with
 * it, so the page says nothing about who the link was for.
 */

export interface EmailLinkDeps {
  readonly transaction: <T>(work: (runner: QueryRunner) => Promise<T>) => Promise<T>;
  readonly now: Date;
  /** The server's link secret, or null when none is configured. */
  readonly secret: string | null;
}

export type EmailLinkResult =
  | { readonly ok: true; readonly customerId: string; readonly changed: boolean }
  | { readonly ok: false };

const input = z.object({ token: z.string().min(1).max(200) });

/** Whether a link is worth showing the button for. Changes nothing. */
export function isUsableLink(
  token: unknown,
  purpose: EmailLinkPurpose,
  secret: string | null,
): boolean {
  if (secret === null || typeof token !== "string" || token.length > 200) return false;
  return readEmailLinkToken(token, purpose, secret) !== null;
}

export async function actOnEmailLink(
  purpose: EmailLinkPurpose,
  raw: unknown,
  deps: EmailLinkDeps,
): Promise<EmailLinkResult> {
  const parsed = input.safeParse(raw);
  if (!parsed.success || deps.secret === null) return { ok: false };
  const customerId = readEmailLinkToken(parsed.data.token, purpose, deps.secret);
  if (customerId === null) return { ok: false };

  if (purpose === "confirm") {
    const changed = await deps.transaction((runner) =>
      confirmMarketingConsent(runner, customerId, deps.now),
    );
    return { ok: true, customerId, changed };
  }
  await deps.transaction((runner) => unsubscribeCustomer(runner, customerId, deps.now));
  return { ok: true, customerId, changed: true };
}
