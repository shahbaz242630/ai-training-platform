import type { Metadata } from "next";
import { headers } from "next/headers";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { Container } from "@/components/ui/Container";
import { BOOKING_POLICY, POLICY_LINKS } from "@/config/site";
import { withTransaction } from "@/data/db";
import { clientAddressFrom } from "@/lib/client-address";
import { serverEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createRateLimiter } from "@/lib/rate-limit";
import { offeredSlots } from "../[slug]/availability";
import { LINK_MESSAGE, MESSAGES, loadManageView } from "./flow";
import { RescheduleForm } from "./RescheduleForm";

/**
 * Managing a booking from the link in the customer's email. The link is the
 * identity: it is signed, names one booking and expires when the session
 * starts. Under /training/book/ so it is served with the per-request nonce
 * policy, like every other page that shows personal booking details.
 */

export const dynamic = "force-dynamic";

/*
  Every load reads the live calendar, which Microsoft throttles at four
  requests at a time per mailbox. A customer opens this page a handful of
  times; twenty a minute per address stops a reloaded or forwarded link from
  crowding out real bookings.
*/
const pageLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

export const metadata: Metadata = {
  title: "Manage your booking",
  robots: { index: false, follow: false },
  // The link in the address bar is the customer's key: never send it on.
  referrer: "no-referrer",
};

export default async function ManagePage({ searchParams }: PageProps<"/training/book/manage">) {
  const { t } = await searchParams;
  const token = typeof t === "string" ? t.slice(0, 300) : "";

  const secret = serverEnv().MANAGE_LINK_SECRET;
  const address = clientAddressFrom((await headers()).get("x-forwarded-for"));
  const rate = pageLimiter.check(address, new Date());
  let content: React.ReactNode;
  if (!secret) {
    logger.error("MANAGE_LINK_SECRET is not set, so the manage page cannot open any booking");
    content = <Notice message={MESSAGES.BROKEN} />;
  } else if (!rate.allowed) {
    content = (
      <Notice
        message={`Too many requests. Please try again in ${rate.retryAfterSeconds} seconds.`}
      />
    );
  } else if (token === "") {
    content = <Notice message={LINK_MESSAGE()} />;
  } else {
    const result = await loadManageView(token, {
      transaction: withTransaction,
      now: new Date(),
      secret,
      offered: offeredSlots,
    }).catch((error: unknown) => {
      logger.error("the manage page could not load a booking", {
        error: (error as Error).message,
      });
      return { ok: false as const, message: MESSAGES.BROKEN };
    });
    content = result.ok ? (
      <RescheduleForm token={token} view={result.view} />
    ) : (
      <Notice message={result.message} />
    );
  }

  return (
    <>
      <SiteHeader />
      <main id="main" className="py-16 sm:py-24">
        <Container>
          <div className="mx-auto grid max-w-[1000px] gap-12 lg:grid-cols-[1fr_420px]">
            <div>
              <h1 className="text-ink mb-6 font-serif text-[clamp(34px,4.2vw,46px)] leading-[1.1] font-[450] tracking-[-0.02em] text-balance">
                Manage your booking
              </h1>
              <p className="text-ink-soft text-[17px] leading-[1.65]">
                You can move your session once, free, to any open time within{" "}
                {BOOKING_POLICY.moveWindowDays} days, as long as you do it at least{" "}
                {BOOKING_POLICY.moveNoticeHours} hours before it starts. After that, the new time is
                final.
              </p>
              <p className="text-ink-muted mt-4 text-[15px] leading-[1.65]">
                The{" "}
                <a
                  href={POLICY_LINKS.bookingAndRefunds}
                  className="text-accent underline underline-offset-[3px]"
                >
                  Booking and Refund Policy
                </a>{" "}
                has the full details.
              </p>
            </div>
            {content}
          </div>
        </Container>
      </main>
      <SiteFooter />
    </>
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
