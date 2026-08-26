import { Container } from "@/components/ui/Container";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { getSessionByCode, type SessionType } from "@/config/sessions";

/**
 * The progression band is load-bearing, not decorative.
 *
 * V1 sells the full Session 1-6 ladder, which spans two very different buyers:
 * someone who has never moved past a chat window, and someone shipping to
 * production. This band exists so each of them can locate themselves quickly
 * instead of reading six cards to find out which two are relevant.
 */
interface Stage {
  readonly name: string;
  readonly description: string;
  readonly codes: readonly SessionType["code"][];
}

const STAGES: readonly Stage[] = [
  {
    name: "AI User",
    description: "Get reliable, repeatable results instead of guessing at prompts.",
    codes: ["S1"],
  },
  {
    name: "AI Builder",
    description: "Turn ideas into working output using coding agents and real tooling.",
    codes: ["S2", "S3"],
  },
  {
    name: "Agent Operator",
    description: "Run agents that execute real tasks, with safe boundaries.",
    codes: ["S4"],
  },
  {
    name: "AI Implementer",
    description: "Understand the whole stack and deploy something real.",
    codes: ["S5", "S6"],
  },
];

export function Progression() {
  return (
    <section aria-labelledby="progression-heading" className="border-line border-b py-20 sm:py-24">
      <Container>
        <div className="max-w-2xl">
          <SectionLabel>Where you are now</SectionLabel>
          <h2
            id="progression-heading"
            className="text-ink text-3xl font-semibold tracking-[-0.025em] text-balance sm:text-4xl"
          >
            Four stages, six sessions. Start wherever you actually are.
          </h2>
          <p className="text-ink-muted mt-5 text-base leading-relaxed">
            You do not have to begin at the beginning. Find the stage that describes you today and
            book the session that moves you to the next one.
          </p>
        </div>

        <ol className="mt-14 grid gap-px sm:grid-cols-2 lg:grid-cols-4">
          {STAGES.map((stage, index) => (
            <li key={stage.name} className="bg-surface border-line flex flex-col border p-6 sm:p-7">
              <span
                className="text-ink-faint text-xs font-semibold tabular-nums"
                aria-hidden="true"
              >
                0{index + 1}
              </span>
              <h3 className="text-ink mt-3 text-lg font-semibold tracking-tight">{stage.name}</h3>
              <p className="text-ink-muted mt-2.5 mb-6 text-sm leading-relaxed">
                {stage.description}
              </p>

              {/* mt-auto keeps the divider and chips on a shared baseline across
                  cards, even though the descriptions differ in length. */}
              <div className="border-line mt-auto flex flex-wrap gap-2 border-t pt-4">
                {stage.codes.map((code) => {
                  const session = getSessionByCode(code);
                  if (!session) return null;
                  return (
                    <a
                      key={code}
                      href={`#${session.slug}`}
                      className="bg-accent-soft text-accent hover:bg-accent inline-flex rounded px-2.5 py-1 text-xs font-semibold transition-colors hover:text-white"
                    >
                      Session {code.slice(1)}
                    </a>
                  );
                })}
              </div>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
