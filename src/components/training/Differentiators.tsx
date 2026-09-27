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
    body: "Which model, which ecosystem, which approach, and just as importantly, when a given tool is the wrong choice.",
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
    <section
      aria-labelledby="different-heading"
      className="bg-deep text-on-deep py-16 sm:py-[104px]"
    >
      <Container>
        <div className="max-w-[640px]">
          <p className="text-on-deep-accent mb-3.5 font-mono text-[13px]">Why this is different</p>
          <h2
            id="different-heading"
            className="font-serif text-[clamp(32px,4vw,48px)] leading-[1.1] font-[450] tracking-[-0.015em] text-balance"
          >
            Not a generic AI course.
          </h2>
          <p className="text-on-deep-lede mt-3.5 text-base leading-relaxed text-pretty">
            Most AI training explains features. These sessions are about doing the work, with your
            projects, your constraints and your questions in the room.
          </p>
        </div>

        <ol className="border-deep-soft mt-14 grid border-t sm:grid-cols-2 lg:grid-cols-3">
          {POINTS.map((point, index) => (
            <li
              key={point.title}
              className="border-deep-soft flex flex-col gap-2 border-b py-7 pr-7"
            >
              <span className="text-on-deep-accent font-mono text-xs" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3 className="font-serif text-[21px] leading-[1.3] font-medium">{point.title}</h3>
              <p className="text-on-deep-muted text-[14.5px] leading-relaxed">{point.body}</p>
            </li>
          ))}
        </ol>
      </Container>
    </section>
  );
}
