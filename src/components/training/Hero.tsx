import { Container } from "@/components/ui/Container";
import { ButtonLink } from "@/components/ui/Button";
import { getActiveSessions } from "@/config/sessions";
import { formatAed } from "@/lib/money";
import { SITE, DELIVERY } from "@/config/site";

/**
 * The hero must convey all of this within one viewport: private 1-to-1
 * delivery, practical positioning, Dubai identity, evening availability, a
 * price signal, and the primary call to action.
 */
export function Hero() {
  const sessions = getActiveSessions();
  const lowest = sessions.reduce(
    (min, s) => (s.priceFils < min ? s.priceFils : min),
    sessions[0]!.priceFils,
  );

  const facts = [
    `${DELIVERY.durationMinutes} minutes`,
    "Private 1-to-1",
    "Online via Microsoft Teams",
    "Evening sessions",
  ];

  return (
    <section className="border-line border-b pt-16 pb-20 sm:pt-24 sm:pb-28">
      <Container>
        <div className="max-w-3xl">
          <p className="text-ink-muted mb-6 text-xs font-semibold tracking-[0.18em] uppercase">
            Private 1-to-1 AI training
            <span className="text-line-strong mx-2.5" aria-hidden="true">
              /
            </span>
            {SITE.serviceArea}
          </p>

          <h1 className="text-ink text-[2.6rem] leading-[1.05] font-semibold tracking-[-0.035em] text-balance sm:text-[3.5rem] lg:text-[4rem]">
            Learn how to work with AI — not just talk to it.
          </h1>

          <p className="text-ink-muted mt-7 max-w-2xl text-lg leading-relaxed">
            Practical sessions for professionals, founders and builders. Research and prompting,
            ChatGPT and Codex, Claude and Claude Code, AI agents, the technology stack behind modern
            AI applications, and real production deployment.
          </p>

          <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
            <ButtonLink href="#sessions">Explore sessions</ButtonLink>
            <ButtonLink href="#how-it-works" variant="secondary">
              How it works
            </ButtonLink>
          </div>

          <p className="text-ink-faint mt-6 text-sm">
            From <span className="text-ink font-semibold tabular-nums">{formatAed(lowest)}</span>{" "}
            per session. No package required.
          </p>
        </div>

        <ul className="border-line mt-16 grid grid-cols-2 gap-x-6 gap-y-5 border-t pt-8 lg:grid-cols-4">
          {facts.map((fact) => (
            <li key={fact} className="text-ink-muted text-sm font-medium">
              {fact}
            </li>
          ))}
        </ul>
      </Container>
    </section>
  );
}
