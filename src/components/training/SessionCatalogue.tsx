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
    <article
      id={session.slug}
      className="bg-surface border-line scroll-mt-28 border-t last:border-b"
    >
      <div className="flex flex-col gap-6 p-6 sm:p-8 lg:flex-row lg:items-start lg:gap-10">
        <span
          className="text-line-strong hidden text-5xl leading-none font-semibold tabular-nums lg:block"
          aria-hidden="true"
        >
          {number}
        </span>

        <div className="min-w-0 flex-1">
          <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-ink-faint text-xs font-semibold tracking-[0.14em] uppercase lg:hidden">
              Session {number}
            </span>
            <span className="border-line text-ink-muted rounded border px-2 py-0.5 text-xs font-medium">
              {LEVEL_LABEL[session.level]}
            </span>
            {session.category === "implementation" && (
              <span className="bg-accent-soft text-accent rounded px-2 py-0.5 text-xs font-semibold">
                Prerequisites apply
              </span>
            )}
          </div>

          <h3 className="text-ink text-xl font-semibold tracking-tight text-balance sm:text-2xl">
            {session.title}
          </h3>

          <p className="text-ink-muted mt-3 max-w-2xl text-[15px] leading-relaxed">
            {session.summary}
          </p>

          <p className="text-ink-muted mt-4 max-w-2xl text-sm leading-relaxed">
            <span className="text-ink-faint">Who it’s for: </span>
            {session.audience}
          </p>

          <details className="group mt-6" name="session-detail" id={detailId}>
            <summary className="text-ink hover:text-accent inline-flex items-center gap-2 text-sm font-semibold transition-colors">
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

            <div className="border-line mt-6 grid gap-8 border-t pt-6 sm:grid-cols-2">
              <div>
                <h4 className="text-ink text-xs font-semibold tracking-[0.14em] uppercase">
                  What we cover
                </h4>
                <ul className="mt-4 space-y-2">
                  {session.topics.map((topic) => (
                    <li key={topic} className="text-ink-muted flex gap-2.5 text-sm leading-relaxed">
                      <span
                        className="bg-accent mt-2 size-1 shrink-0 rounded-full"
                        aria-hidden="true"
                      />
                      {topic}
                    </li>
                  ))}
                </ul>
              </div>

              <div>
                <h4 className="text-ink text-xs font-semibold tracking-[0.14em] uppercase">
                  What you leave with
                </h4>
                <p className="text-ink-muted mt-4 text-sm leading-relaxed">{session.outcome}</p>

                {session.prerequisiteNote && (
                  <div className="border-line-strong mt-6 border-l-2 pl-4">
                    <h4 className="text-ink text-xs font-semibold tracking-[0.14em] uppercase">
                      Before you book
                    </h4>
                    <p className="text-ink-muted mt-3 text-sm leading-relaxed">
                      {session.prerequisiteNote}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </details>
        </div>

        <div className="border-line flex shrink-0 flex-row items-center justify-between gap-4 border-t pt-6 lg:w-44 lg:flex-col lg:items-end lg:border-t-0 lg:pt-0">
          <div className="lg:text-right">
            <p className="text-ink text-2xl font-semibold tracking-tight tabular-nums">
              {formatAed(session.priceFils)}
            </p>
            <p className="text-ink-faint mt-1 text-xs">{session.durationMinutes} minutes</p>
          </div>
          <ButtonLink
            href={`/training/book/${session.slug}`}
            className="!px-5 !py-2.5 whitespace-nowrap lg:w-full"
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
      className="scroll-mt-24 py-20 sm:py-24"
      id="sessions"
    >
      <OpenSessionFromHash />
      <Container>
        <div className="max-w-2xl">
          <SectionLabel>The sessions</SectionLabel>
          <h2
            id="sessions-heading"
            className="text-ink text-3xl font-semibold tracking-[-0.025em] text-balance sm:text-4xl"
          >
            Six sessions, priced by depth. Buy only what you need.
          </h2>
          <p className="text-ink-muted mt-5 text-base leading-relaxed">
            Each session is {sessions[0]!.durationMinutes} minutes, delivered privately over
            Microsoft Teams, and built around your own work rather than a fixed curriculum.
          </p>
        </div>

        <div className="mt-14">
          {sessions.map((session) => (
            <SessionRow key={session.code} session={session} />
          ))}
        </div>
      </Container>
    </section>
  );
}
