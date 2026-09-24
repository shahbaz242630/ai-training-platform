import { Container } from "@/components/ui/Container";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { ButtonLink } from "@/components/ui/Button";
import { getActiveSessions, type SessionType } from "@/config/sessions";
import { formatAed } from "@/lib/money";
import { OpenSessionFromHash } from "@/components/training/OpenSessionFromHash";

const LEVEL_LABEL: Record<SessionType["level"], string> = {
  foundation: "Foundation",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

function SessionRow({ session }: { session: SessionType }) {
  const number = session.code.slice(1);
  const detailId = `${session.slug}-detail`;

  return (
    <article id={session.slug} className="border-line scroll-mt-28 border-b">
      <div className="grid grid-cols-1 items-start gap-x-8 gap-y-6 py-8 lg:grid-cols-[72px_minmax(0,1fr)_200px]">
        <span
          className="text-on-deep-lede hidden font-serif text-[44px] leading-none lg:block"
          aria-hidden="true"
        >
          {number}
        </span>

        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-ink-faint font-mono text-xs lg:hidden">Session {number}</span>
            <span className="border-line-strong text-ink-muted rounded-md border px-[9px] py-[3px] font-mono text-xs">
              {LEVEL_LABEL[session.level]}
            </span>
            {session.category === "implementation" && (
              <span className="bg-accent-soft text-accent rounded-md px-[9px] py-[3px] text-[12.5px] font-medium">
                Prerequisites apply
              </span>
            )}
          </div>

          <h3 className="text-ink font-serif text-[26px] leading-[1.2] font-medium text-balance">
            {session.title}
          </h3>

          <p className="text-ink-soft mt-3 max-w-[640px] text-[15.5px] leading-relaxed">
            {session.summary}
          </p>

          <p className="text-ink-muted mt-3 max-w-[640px] text-[14.5px] leading-relaxed">
            <span className="text-ink-faint">Who it’s for: </span>
            {session.audience}
          </p>

          <details className="group mt-[18px]" name="session-detail" id={detailId}>
            <summary className="text-ink hover:text-accent inline-flex items-center gap-2 text-[14.5px] font-medium transition-colors">
              <span className="group-open:hidden">View what we cover</span>
              <span className="hidden group-open:inline">Hide details</span>
              <svg
                className="size-3.5 transition-transform group-open:rotate-180"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4 6l4 4 4-4"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </summary>

            <div className="border-panel animate-z-in mt-2 grid gap-7 border-t pt-[22px] sm:grid-cols-2">
              <div>
                <h4 className="text-accent font-mono text-xs font-normal">What we cover</h4>
                <ul className="mt-3 space-y-2">
                  {session.topics.map((topic) => (
                    <li
                      key={topic}
                      className="text-ink-soft flex gap-2.5 text-[14.5px] leading-normal"
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

              <div>
                <h4 className="text-accent font-mono text-xs font-normal">What you leave with</h4>
                <p className="text-ink-soft mt-3 text-[14.5px] leading-relaxed">
                  {session.outcome}
                </p>

                {session.prerequisiteNote && (
                  <div className="bg-canvas border-line mt-4 rounded-xl border px-[18px] py-4">
                    <h4 className="text-accent font-mono text-xs font-normal">Before you book</h4>
                    <p className="text-ink-muted mt-2 text-sm leading-relaxed">
                      {session.prerequisiteNote}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </details>
        </div>

        <div className="border-panel flex flex-row items-center justify-between gap-4 border-t pt-6 lg:flex-col lg:items-end lg:gap-3.5 lg:border-t-0 lg:pt-0">
          <div className="lg:text-right">
            <p className="text-ink font-serif text-[26px] font-medium tabular-nums">
              {formatAed(session.priceFils)}
            </p>
            <p className="text-ink-faint mt-[3px] font-mono text-xs">
              {session.durationMinutes} minutes
            </p>
          </div>
          <ButtonLink
            href={`/training/book/${session.slug}`}
            className="!px-5 !py-[11px] !text-[14.5px]"
          >
            Book session {number}
          </ButtonLink>
        </div>
      </div>
    </article>
  );
}

export function SessionCatalogue() {
  const sessions = getActiveSessions();

  return (
    <section
      aria-labelledby="sessions-heading"
      className="bg-surface border-line scroll-mt-24 border-y py-16 sm:py-[104px]"
      id="sessions"
    >
      <OpenSessionFromHash />
      <Container>
        <div className="max-w-[640px]">
          <SectionLabel>The sessions</SectionLabel>
          <h2
            id="sessions-heading"
            className="text-ink font-serif text-[clamp(32px,4vw,44px)] leading-[1.12] font-[450] tracking-[-0.015em] text-balance"
          >
            Six sessions, priced by depth. Buy only what you need.
          </h2>
          <p className="text-ink-muted mt-3.5 text-base leading-relaxed text-pretty">
            Each session is {sessions[0]!.durationMinutes} minutes, delivered privately over
            Microsoft Teams, and built around your own work rather than a fixed curriculum.
          </p>
        </div>

        <div className="border-line mt-12 border-t">
          {sessions.map((session) => (
            <SessionRow key={session.code} session={session} />
          ))}
        </div>
      </Container>
    </section>
  );
}
