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
  /** The secrets a link may be signed with; empty when none is configured. */
  readonly secrets: readonly string[];
}

export type EmailLinkResult =
  | { readonly ok: true; readonly customerId: string; readonly changed: boolean }
  | { readonly ok: false };

const input = z.object({ token: z.string().min(1).max(200) });

/** Whether a link is worth showing the button for. Changes nothing. */
export function isUsableLink(
  token: unknown,
  purpose: EmailLinkPurpose,
  secrets: readonly string[],
): boolean {
  if (secrets.length === 0 || typeof token !== "string" || token.length > 200) return false;
  return readEmailLinkToken(token, purpose, secrets) !== null;
}

export async function actOnEmailLink(
  purpose: EmailLinkPurpose,
  raw: unknown,
  deps: EmailLinkDeps,
): Promise<EmailLinkResult> {
  const parsed = input.safeParse(raw);
  if (!parsed.success || deps.secrets.length === 0) return { ok: false };
  const customerId = readEmailLinkToken(parsed.data.token, purpose, deps.secrets);
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
