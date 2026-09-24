import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { Container } from "@/components/ui/Container";
import { ButtonLink } from "@/components/ui/Button";
import { BookingPanel } from "@/components/training/BookingPanel";
import { getSessionBySlug, getActiveSessions } from "@/config/sessions";
import { formatAed } from "@/lib/money";
import { offeredSlots } from "./availability";
import { paymentsAreConfigured } from "@/domain/payments/factory";
import { logger } from "@/lib/logger";

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
    depends on the working-hours rules, on what is already on the calendar, and
    on which times another customer is part-way through paying for.

    A failure to read it is NOT recoverable into an empty calendar. Rendering
    "no times available" when the database is unreachable would tell a
    customer something false about the business and hide an outage; rendering
    the full grid would offer times we cannot verify are free. So the panel is
    told the truth and says so.
  */
  let slots: readonly { start: Date }[] = [];
  let availabilityFailed = false;
  try {
    slots = await offeredSlots(session.durationMinutes, now);
  } catch (error) {
    availabilityFailed = true;
    logger.error("availability could not be read", { error: (error as Error).message });
  }

  return (
    <>
      <SiteHeader />
      <main id="main" className="pt-12 pb-16 sm:pt-[72px] sm:pb-[88px]">
        <Container>
          {/*
            The session on the left, the booking box on the right. On a narrow
            screen they stack, with the details first: somebody still deciding
            whether they want the session should not have to scroll past a
            calendar to read what it is.
          */}
          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-16">
            <div className="flex flex-col">
              <p className="text-accent mb-[18px] font-mono text-[13px]">
                Session {session.code.slice(1)}
              </p>
              <h1 className="text-ink mb-5 font-serif text-[clamp(36px,4.4vw,48px)] leading-[1.08] font-[450] tracking-[-0.02em] text-balance">
                {session.title}
              </h1>
              <p className="text-ink-soft max-w-[560px] text-[17px] leading-relaxed">
                {session.summary}
              </p>

              <dl className="border-line mt-8 grid max-w-[560px] grid-cols-2 border-y">
                <div className="flex flex-col gap-1.5 py-5">
                  <dt className="text-ink-faint font-mono text-xs">Price</dt>
                  <dd className="text-ink font-serif text-2xl font-medium tabular-nums">
                    {formatAed(session.priceFils)}
                  </dd>
                </div>
                <div className="border-line flex flex-col gap-1.5 border-l py-5 pl-6">
                  <dt className="text-ink-faint font-mono text-xs">Duration</dt>
                  <dd className="text-ink font-serif text-2xl font-medium tabular-nums">
                    {session.durationMinutes} min
                  </dd>
                </div>
              </dl>

              <div className="mt-8">
                <h2 className="text-accent font-mono text-xs font-normal">
                  What this session covers
                </h2>
                <ul className="mt-3.5 space-y-[9px]">
                  {session.topics.map((topic) => (
                    <li
                      key={topic}
                      className="text-ink-soft flex gap-2.5 text-[15px] leading-normal"
                    >
                      <span
                        className="bg-accent-dot mt-2 size-[5px] shrink-0 rounded-full"
                        aria-hidden="true"
                      />
                      {topic}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="mt-10">
                <ButtonLink
                  href={`/training#${session.slug}`}
                  variant="secondary"
                  className="!px-[22px] !py-3 !text-[15px]"
                >
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
                /*
                  Asked BEFORE the form is shown, not after it is filled in.
                  Without this a customer types their name, email and goal, has
                  those committed to the database, chooses a time, presses pay -
                  and only then learns that payment is unavailable. The check
                  existed and was tested; nothing consulted it.
                */
                paymentsAvailable={paymentsAreConfigured()}
                slug={session.slug}
                slotStarts={slots.map((slot) => slot.start.toISOString())}
                durationMinutes={session.durationMinutes}
                priceLabel={formatAed(session.priceFils)}
                availabilityFailed={availabilityFailed}
              />
            </aside>
          </div>
        </Container>
      </main>
      <SiteFooter />
    </>
  );
}
