import { Container } from "@/components/ui/Container";
import { ButtonLink } from "@/components/ui/Button";
import { getActiveSessions } from "@/config/sessions";
import { formatAed } from "@/lib/money";

export function FinalCta() {
  const sessions = getActiveSessions();
  const lowest = sessions.reduce(
    (min, s) => (s.priceFils < min ? s.priceFils : min),
    sessions[0]!.priceFils,
  );

  return (
    <section aria-labelledby="cta-heading" className="py-20 sm:py-28">
      <Container>
        <div className="max-w-2xl">
          <h2
            id="cta-heading"
            className="text-ink text-3xl font-semibold tracking-[-0.025em] text-balance sm:text-4xl"
          >
            Pick the session that matches your next problem.
          </h2>
          <p className="text-ink-muted mt-5 text-base leading-relaxed">
            From {formatAed(lowest)}. One session at a time, no package to commit to, and no sales
            call before you can book.
          </p>
          <div className="mt-9">
            <ButtonLink href="#sessions">Explore sessions</ButtonLink>
          </div>
        </div>
      </Container>
    </section>
  );
}
