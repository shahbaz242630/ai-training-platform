import { Container } from "@/components/ui/Container";
import { ButtonLink } from "@/components/ui/Button";
import { BookingDemo } from "@/components/training/BookingDemo";
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

  // The first four sessions, as the booking card shows them. Prices come
  // from the catalogue, formatted, never built here.
  const demo = sessions
    .slice(0, 4)
    .map((s) => ({ name: s.shortTitle, price: formatAed(s.priceFils) }));

  return (
    <>
      <section>
        <Container className="grid grid-cols-1 items-center gap-14 pt-14 pb-16 sm:pt-[88px] sm:pb-24 lg:grid-cols-2">
          <div className="flex flex-col">
            <p className="text-accent mb-[22px] flex flex-wrap gap-2.5 font-mono text-[13px]">
              <span>Private 1-to-1 AI training</span>
              <span className="text-on-deep-muted" aria-hidden="true">
                /
              </span>
              <span>{SITE.serviceArea}</span>
            </p>

            <h1 className="text-ink mb-6 font-serif text-[clamp(42px,5.2vw,60px)] leading-[1.06] font-[450] tracking-[-0.02em] text-balance">
              Learn how to work with AI — not just talk to it.
            </h1>

            <p className="text-ink-soft mb-8 max-w-[520px] text-lg leading-relaxed text-pretty">
              Practical sessions for professionals, founders and builders. Research and prompting,
              ChatGPT and Codex, Claude and Claude Code, AI agents, the technology stack behind
              modern AI applications, and real production deployment.
            </p>

            <div className="flex flex-wrap items-center gap-3">
              <ButtonLink href="#sessions">Explore sessions</ButtonLink>
              <ButtonLink href="#how-it-works" variant="secondary">
                How it works
              </ButtonLink>
            </div>

            <p className="text-ink-muted mt-[22px] text-[14.5px]">
              From <span className="text-ink font-medium tabular-nums">{formatAed(lowest)}</span>{" "}
              per session. No package required.
            </p>
          </div>

          <BookingDemo
            sessions={demo}
            durationMinutes={DELIVERY.durationMinutes}
            platform="Microsoft Teams"
          />
        </Container>
      </section>

      <div className="border-line border-y">
        <ul className="mx-auto grid max-w-[1180px] grid-cols-2 lg:grid-cols-4">
          {facts.map((fact, i) => (
            <li
              key={fact}
              className={`text-ink-muted border-line flex items-center gap-2 px-[22px] py-5 text-[14.5px] sm:px-8 ${
                i % 2 === 1 ? "border-l" : ""
              } ${i === 2 ? "lg:border-l" : ""} ${i >= 2 ? "max-lg:border-t" : ""}`}
            >
              <span
                className="bg-accent-dot h-[7px] w-[7px] shrink-0 rounded-full"
                aria-hidden="true"
              />
              {fact}
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
