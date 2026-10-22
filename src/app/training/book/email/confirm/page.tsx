import type { Metadata } from "next";
import { emailLinkKeys } from "@/lib/email-link";
import { serverEnv } from "@/lib/env";
import { confirmEmailsAction, type LinkOutcome } from "../actions";
import { EmailLinkPage } from "../EmailLinkPage";
import { isUsableLink } from "../flow";

/*
  Under /training/book/ so it gets the per-request nonce policy and the booking
  pages' rate rule, like every other page that acts on somebody's details.
*/
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Confirm emails about new sessions",
  robots: { index: false, follow: false },
};

const OUTCOMES: ReadonlySet<string> = new Set<LinkOutcome>(["done", "invalid", "busy", "error"]);

export default async function Page({ searchParams }: PageProps<"/training/book/email/confirm">) {
  const { t, outcome } = await searchParams;
  const env = serverEnv();
  const secrets = emailLinkKeys(env.EMAIL_LINK_SECRET, env.EMAIL_LINK_SECRET_PREVIOUS).read;
  return (
    <EmailLinkPage
      purpose="confirm"
      token={isUsableLink(t, "confirm", secrets) ? (t as string) : null}
      outcome={
        typeof outcome === "string" && OUTCOMES.has(outcome) ? (outcome as LinkOutcome) : null
      }
      action={confirmEmailsAction}
    />
  );
}
