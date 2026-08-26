import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { Container } from "@/components/ui/Container";
import { ButtonLink } from "@/components/ui/Button";
import { SlotPicker } from "@/components/training/SlotPicker";
import { getSessionBySlug, getActiveSessions } from "@/config/sessions";
import { formatAed } from "@/lib/money";
import { addDays } from "@/lib/time";
import { MockSchedulingProvider } from "@/domain/scheduling/mock-provider";

/**
 * How far ahead the calendar shows. The booking horizon in the availability
 * rules is the real limit; this only decides how much of it is on screen at
 * once, because a wall of three months of slots is harder to choose from than
 * a few weeks of them.
 */
const WEEKS_SHOWN = 3;

/*
  Rendered per request rather than at build time. Availability depends on the
  current time - a page built on Tuesday would still be offering Tuesday's
  slots on Friday. Every other route in the site stays static.
*/
export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return getActiveSessions().map((session) => ({ slug: session.slug }));
}

export async function generateMetadata({
  params,
}: PageProps<"/training/book/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const session = getSessionBySlug(slug);
  return {
    title: session ? `Book — ${session.title}` : "Book a session",
    robots: { index: false, follow: false },
  };
}

export default async function BookSessionPage({ params }: PageProps<"/training/book/[slug]">) {
  const { slug } = await params;
  const session = getSessionBySlug(slug);
  if (!session || !session.active) notFound();

  /*
    Availability is decided HERE, on the server, and never in the browser. It
    depends on the working-hours rules and on what is already on the calendar,
    and a browser must not be the authority on what is bookable. The mock
    provider applies the real rules; swapping it for the Microsoft Graph one
    later changes this line and nothing else on the page.
  */
  const scheduler = new MockSchedulingProvider();
  const now = new Date();
  const slots = await scheduler.listAvailability({
    from: now,
    to: addDays(now, WEEKS_SHOWN * 7),
    durationMinutes: session.durationMinutes,
  });

  return (
    <>
      <SiteHeader />
      <main id="main" className="py-20 sm:py-28">
        <Container>
          <div className="max-w-xl">
            <p className="text-ink-muted mb-4 text-xs font-semibold tracking-[0.18em] uppercase">
              Session {session.code.slice(1)}
            </p>
            <h1 className="text-ink text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">
              {session.title}
            </h1>
            <p className="text-ink-muted mt-5 text-base leading-relaxed">{session.summary}</p>

            <dl className="border-line mt-8 grid grid-cols-2 gap-6 border-y py-6">
              <div>
                <dt className="text-ink-faint text-xs tracking-[0.14em] uppercase">Price</dt>
                <dd className="text-ink mt-2 text-xl font-semibold tabular-nums">
                  {formatAed(session.priceFils)}
                </dd>
              </div>
              <div>
                <dt className="text-ink-faint text-xs tracking-[0.14em] uppercase">Duration</dt>
                <dd className="text-ink mt-2 text-xl font-semibold tabular-nums">
                  {session.durationMinutes} min
                </dd>
              </div>
            </dl>

            <section aria-labelledby="choose-a-time" className="mt-10">
              <h2 id="choose-a-time" className="text-ink text-lg font-semibold">
                Choose a time
              </h2>
              <p className="text-ink-muted mt-2 mb-6 text-sm leading-relaxed">
                Every session is one to one and runs for {session.durationMinutes} minutes.
              </p>

              {/*
                Disabled on purpose. Payment is not connected yet, and a slot
                that can be chosen but not paid for is a promise we cannot keep.
                The calendar is shown rather than hidden so the times on offer
                are visible, and honest about what they are.
              */}
              <SlotPicker
                slotStarts={slots.map((slot) => slot.start.toISOString())}
                durationMinutes={session.durationMinutes}
                disabled
              />
            </section>

            <div className="bg-raised border-line mt-10 rounded-lg border p-6">
              <h2 className="text-ink text-base font-semibold">Booking is not open yet</h2>
              <p className="text-ink-muted mt-3 text-sm leading-relaxed">
                These are real times, but they cannot be reserved yet — online payment is still
                being set up. When it opens you will complete a short intake, choose a slot, and
                pay, and the booking is confirmed only once payment has been verified.
              </p>
            </div>

            <div className="mt-8">
              <ButtonLink href={`/training#${session.slug}`} variant="secondary">
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
