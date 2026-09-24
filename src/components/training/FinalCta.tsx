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
    <section aria-labelledby="cta-heading" className="py-16 sm:py-[104px]">
      <Container>
        <div className="mx-auto flex max-w-[720px] flex-col items-center gap-[18px] text-center">
          <h2
            id="cta-heading"
            className="text-ink font-serif text-[clamp(32px,4vw,44px)] leading-[1.12] font-[450] tracking-[-0.015em] text-balance"
          >
            Pick the session that matches your next problem.
          </h2>
          <p className="text-ink-muted max-w-[560px] text-[17px] leading-relaxed text-pretty">
            From {formatAed(lowest)}. One session at a time, no package to commit to, and no sales
            call before you can book.
          </p>
          <div className="mt-3">
            <ButtonLink href="#sessions">Explore sessions</ButtonLink>
          </div>
        </div>
      </Container>
    </section>
  );
}
