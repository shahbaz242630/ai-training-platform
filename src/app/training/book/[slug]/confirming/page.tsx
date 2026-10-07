import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { Container } from "@/components/ui/Container";
import { ButtonLink } from "@/components/ui/Button";
import { getSessionBySlug } from "@/config/sessions";
import { ContactLink } from "@/components/ui/ContactLink";

/**
 * Where Stripe sends somebody after they pay.
 *
 * THIS PAGE CONFIRMS NOTHING, and the wording is careful for that reason. A
 * customer can reach it having paid, and can equally reach it by typing the
 * URL; somebody who genuinely paid can also never reach it at all, by losing
 * their connection on the way back. So it cannot be the thing that decides a
 * booking exists.
 *
 * What confirms a booking is a verified webhook, and nothing else. This page
 * only tells somebody what is happening and what to expect.
 */

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: PageProps<"/training/book/[slug]/confirming">): Promise<Metadata> {
  const { slug } = await params;
  const session = getSessionBySlug(slug);
  return {
    title: session ? `Confirming - ${session.title}` : "Confirming your booking",
    robots: { index: false, follow: false },
  };
}

export default async function ConfirmingPage({
  params,
}: PageProps<"/training/book/[slug]/confirming">) {
  const { slug } = await params;
  const session = getSessionBySlug(slug);
  if (!session) notFound();

  return (
    <>
      <SiteHeader />
      <main id="main" className="py-16 sm:py-24">
        <Container>
          <div className="mx-auto max-w-[600px]">
            <p className="text-accent mb-[22px] flex items-center gap-2.5 font-mono text-[13px]">
              <span
                className="bg-accent-dot h-2 w-2 shrink-0 animate-[z-pulse_1.4s_ease-in-out_infinite] rounded-full"
                aria-hidden="true"
              />
              Session {session.code.slice(1)} · verifying payment
            </p>
            <h1 className="text-ink mb-6 font-serif text-[clamp(34px,4.2vw,46px)] leading-[1.1] font-[450] tracking-[-0.02em] text-balance">
              Thank you - we are confirming your booking
            </h1>

            <p className="text-ink-soft text-[17px] leading-[1.65]">
              Your payment is being verified for{" "}
              <span className="text-ink font-medium">{session.title}</span>. Once it is, your
              session is booked and we will be in touch with the date, the time in your own time
              zone, and how to join.
            </p>

            {/*
              Deliberately does not say "your booking is confirmed". It is not
              confirmed until a verified payment says so, and telling somebody
              otherwise on a page they can simply navigate to is how a customer
              turns up to a session that was never booked.
            */}
            {/*
              Deliberately does not promise an email. Nothing in this system can
              send one yet - there is no email provider wired in - and telling
              somebody who has just paid to wait for a message that will never
              arrive is worse than telling them nothing. When the send path
              exists this becomes a promise we can keep, and not before.
            */}
            <p className="text-ink-muted mt-4 text-[17px] leading-[1.65]">
              If you have not heard from us within one working day, please email{" "}
              <ContactLink showAddress /> and quote the email address you booked with - we will find
              your booking.
            </p>

            <div className="border-line mt-10 border-t pt-8">
              <ButtonLink
                href="/training"
                variant="secondary"
                className="!px-[22px] !py-3 !text-[15px]"
              >
                Back to all sessions
              </ButtonLink>
            </div>
          </div>
        </Container>
      </main>
      <SiteFooter />
    </>
  );
}
