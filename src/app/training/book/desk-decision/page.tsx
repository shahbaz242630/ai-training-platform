import type { Metadata } from "next";
import { headers } from "next/headers";
import { Container } from "@/components/ui/Container";
import { withTransaction } from "@/data/db";
import { limitKeyFrom } from "@/lib/client-address";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createRateLimiter } from "@/lib/rate-limit";
import { DeclineButton } from "./DeclineButton";
import { LINK_NOT_VALID, loadDeskDecision, type DeskNoticeView } from "./flow";

/**
 * For the booking desk only: decline a withdrawal from the link in its alert.
 * Opening this page changes nothing, because mail scanners open links; the
 * button is the decision. Under /training/book/ so it is served with the
 * per-request nonce policy, never indexed, and never sends its address on.
 */

export const dynamic = "force-dynamic";

const pageLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

export const metadata: Metadata = {
  title: "Withdrawal decision",
  robots: { index: false, follow: false },
  // The link in the address bar is the desk's key: never send it on.
  referrer: "no-referrer",
};

export default async function DeskDecisionPage({
  searchParams,
}: PageProps<"/training/book/desk-decision">) {
  const { t } = await searchParams;
  const token = typeof t === "string" ? t.slice(0, 300) : "";
  const secret = serverEnv().MANAGE_LINK_SECRET;
  const rate = pageLimiter.check(
    limitKeyFrom((await headers()).get("x-forwarded-for")),
    new Date(),
  );

  let content: React.ReactNode;
  if (!secret) {
    logger.error("MANAGE_LINK_SECRET is not set, so the desk decision page cannot open");
    content = <Notice message="Something went wrong on our side. Please try again later." />;
  } else if (!rate.allowed) {
    content = (
      <Notice message={`Too many requests. Try again in ${rate.retryAfterSeconds} seconds.`} />
    );
  } else {
    const result = await loadDeskDecision(token, {
      transaction: withTransaction,
      now: new Date(),
      secret,
    }).catch((error: unknown) => {
      logger.error("the desk decision page could not load", { error: (error as Error).name });
      return { ok: false as const, message: LINK_NOT_VALID };
    });
    content = result.ok ? (
      <Decision view={result.view} token={token} />
    ) : (
      <Notice message={result.message} />
    );
  }

  return (
    <main id="main" className="py-16 sm:py-24">
      <Container>
        <div className="mx-auto max-w-[560px]">
          <h1 className="text-ink mb-6 font-serif text-[clamp(30px,4vw,40px)] leading-[1.1] font-[450] tracking-[-0.02em]">
            Withdrawal decision
          </h1>
          {content}
        </div>
      </Container>
    </main>
  );
}

function Decision({ view, token }: { readonly view: DeskNoticeView; readonly token: string }) {
  const rows: readonly (readonly [string, string])[] = [
    ["Booking reference", view.reference],
    ["Session", view.sessionTitle],
    ["Notice received", view.received],
    ["Card country", view.cardCountry],
    ["Amount", view.amount],
  ];
  return (
    <div className="border-line-strong bg-surface rounded-2xl border px-6 py-5">
      <dl className="grid gap-2 text-[14.5px]">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-ink-muted">{label}</dt>
            <dd className="text-ink text-right">{value}</dd>
          </div>
        ))}
      </dl>
      {view.state === "open" ? (
        <>
          <p className="text-ink-soft mt-5 text-[15px] leading-relaxed">
            Declining keeps the booking in place, refunds nothing and stops the daily alert.{" "}
            {view.sessionStarted
              ? "The session has already started, so a refund in Stripe would not cancel it: to approve instead, refund in Stripe and write to the customer yourself."
              : "To approve instead, refund the payment in full in Stripe: the booking then cancels itself and the customer is emailed."}
          </p>
          <DeclineButton token={token} />
        </>
      ) : (
        <p role="status" className="text-ink-soft mt-5 text-[15px] leading-relaxed">
          {view.state === "declined"
            ? "This withdrawal has already been declined. The booking stands."
            : "This payment has been refunded, so the withdrawal was approved."}
        </p>
      )}
    </div>
  );
}

function Notice({ message }: { readonly message: string }) {
  return (
    <div className="border-line-strong bg-surface rounded-2xl border px-6 py-5">
      <p role="alert" className="text-ink-soft text-[15px] leading-relaxed">
        {message}
      </p>
    </div>
  );
}
