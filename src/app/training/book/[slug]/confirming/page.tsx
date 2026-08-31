import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { Container } from "@/components/ui/Container";
import { ButtonLink } from "@/components/ui/Button";
import { getSessionBySlug } from "@/config/sessions";

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
          <div className="mx-auto max-w-xl">
            <p className="text-ink-muted mb-4 text-xs font-semibold tracking-[0.18em] uppercase">
              Session {session.code.slice(1)}
            </p>
            <h1 className="text-ink text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">
              Thank you - we are confirming your booking
            </h1>

            <p className="text-ink-muted mt-6 text-base leading-relaxed">
              Your payment is being verified. As soon as it is, you will get an email confirming{" "}
              <span className="text-ink font-semibold">{session.title}</span> with the date, the
              time in your own time zone, and the joining link.
            </p>

            {/*
              Deliberately does not say "your booking is confirmed". It is not
              confirmed until a verified payment says so, and telling somebody
              otherwise on a page they can simply navigate to is how a customer
              turns up to a session that was never booked.
            */}
            <p className="text-ink-muted mt-4 text-base leading-relaxed">
              This usually takes a moment. If you have not had the email within an hour, please get
              in touch and quote the email address you booked with - we will find it.
            </p>

            <div className="border-line mt-10 border-t pt-8">
              <ButtonLink href="/training" variant="secondary">
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
