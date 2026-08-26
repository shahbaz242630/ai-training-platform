import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { Container } from "@/components/ui/Container";
import { ButtonLink } from "@/components/ui/Button";
import { getSessionBySlug, getActiveSessions } from "@/config/sessions";
import { formatAed } from "@/lib/money";

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

/**
 * Placeholder for the real intake -> slot -> checkout flow.
 *
 * It exists now so every "Book" link resolves to a real page rather than a 404,
 * and so the route already sits at its final URL. The copy is deliberately
 * truthful that booking is not open yet, rather than implying otherwise.
 */
export default async function BookSessionPage({ params }: PageProps<"/training/book/[slug]">) {
  const { slug } = await params;
  const session = getSessionBySlug(slug);
  if (!session || !session.active) notFound();

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

            <div className="bg-raised border-line mt-8 rounded-lg border p-6">
              <h2 className="text-ink text-base font-semibold">Booking is not open yet</h2>
              <p className="text-ink-muted mt-3 text-sm leading-relaxed">
                Online booking and payment are still being set up. When it opens you will complete a
                short intake, choose an evening slot, and pay — and the booking is confirmed only
                once payment has been verified.
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
