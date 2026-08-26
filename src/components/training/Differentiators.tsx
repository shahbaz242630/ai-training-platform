import { Container } from "@/components/ui/Container";

/**
 * Differentiate on substance, without attacking competitors by name.
 */
const POINTS = [
  {
    title: "Your work, not a curriculum",
    body: "Sessions are built around a real task you bring. Nothing here is a recorded course you watch alone.",
  },
  {
    title: "Tested, not repeated",
    body: "Everything taught has been used to build and ship real applications, so you get what actually works rather than what sounds impressive.",
  },
  {
    title: "Choosing the right tool",
    body: "Which model, which ecosystem, which approach — and just as importantly, when a given tool is the wrong choice.",
  },
  {
    title: "Agents that do real work",
    body: "The practical difference between a chatbot, an automation and an agent, and how to run one safely.",
  },
  {
    title: "The whole stack",
    body: "How a modern AI application is actually assembled: databases, APIs, hosting, authentication, secrets and monitoring.",
  },
  {
    title: "All the way to production",
    body: "Most training stops at the prototype. Session 6 works through a genuine deployment on your own project.",
  },
];

export function Differentiators() {
  return (
    <section aria-labelledby="different-heading" className="bg-deep text-on-deep py-20 sm:py-24">
      <Container>
        <div className="max-w-2xl">
          <p className="text-on-deep-muted mb-4 text-xs font-semibold tracking-[0.18em] uppercase">
            Why this is different
          </p>
          <h2
            id="different-heading"
            className="text-3xl font-semibold tracking-[-0.025em] text-balance sm:text-4xl"
          >
            Not a generic AI course.
          </h2>
          <p className="text-on-deep-muted mt-5 text-base leading-relaxed">
            Most AI training explains features. These sessions are about doing the work — with your
            projects, your constraints and your questions in the room.
          </p>
        </div>

        <div className="mt-14 grid gap-x-10 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {POINTS.map((point) => (
            <div key={point.title}>
              <h3 className="text-base font-semibold tracking-tight">{point.title}</h3>
              <p className="text-on-deep-muted mt-2.5 text-sm leading-relaxed">{point.body}</p>
            </div>
          ))}
        </div>
      </Container>
    </section>
  );
}
