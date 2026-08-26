import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { Container } from "@/components/ui/Container";
import { ButtonLink } from "@/components/ui/Button";
import { BookingPanel } from "@/components/training/BookingPanel";
import { getSessionBySlug, getActiveSessions } from "@/config/sessions";
import { formatAed } from "@/lib/money";
import { addDays } from "@/lib/time";
import { MockSchedulingProvider } from "@/domain/scheduling/mock-provider";
import { AVAILABILITY } from "@/config/availability";

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

  const now = new Date();

  /*
    Availability is decided HERE, on the server, and never in the browser. It
    depends on the working-hours rules and on what is already on the calendar,
    and a browser must not be the authority on what is bookable. The mock
    provider applies the real rules; swapping it for the Microsoft Graph one
    later changes these lines and nothing else on the page.
  */
  const scheduler = new MockSchedulingProvider();
  const slots = await scheduler.listAvailability({
    from: now,
    to: addDays(now, AVAILABILITY.bookingHorizonDays),
    durationMinutes: session.durationMinutes,
  });

  return (
    <>
      <SiteHeader />
      <main id="main" className="py-16 sm:py-24">
        <Container>
          {/*
            The session on the left, the booking box on the right. On a narrow
            screen they stack, with the details first: somebody still deciding
            whether they want the session should not have to scroll past a
            calendar to read what it is.
          */}
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_400px] lg:gap-14">
            <div>
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

              <div className="mt-8">
                <h2 className="text-ink text-sm font-semibold">What this session covers</h2>
                <ul className="mt-4 space-y-2.5">
                  {session.topics.map((topic) => (
                    <li key={topic} className="text-ink-muted flex gap-3 text-sm leading-relaxed">
                      <span className="text-ink-faint mt-2 h-1 w-1 shrink-0 rounded-full bg-current" />
                      {topic}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-10">
                <ButtonLink href={`/training#${session.slug}`} variant="secondary">
                  Back to all sessions
                </ButtonLink>
              </div>
            </div>

            {/*
              Sticky on a wide screen so the box stays with you while the
              session details are read, and so the total and the button never
              scroll away once a time is chosen.
            */}
            <aside className="lg:sticky lg:top-24 lg:self-start">
              <BookingPanel
                slotStarts={slots.map((slot) => slot.start.toISOString())}
                durationMinutes={session.durationMinutes}
                priceLabel={formatAed(session.priceFils)}
              />
            </aside>
          </div>
        </Container>
      </main>
      <SiteFooter />
    </>
  );
}
