import { Container } from "@/components/ui/Container";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { DELIVERY } from "@/config/site";

const STEPS = [
  {
    title: "Choose the capability you want",
    body: "Pick the session that matches where you are now. There is no consultation call to sit through first.",
  },
  {
    title: "Tell us what you’re working on",
    body: "A short form captures your goal and a real task, so the session is prepared around your situation.",
  },
  {
    title: "Pick an evening slot and pay",
    body: "Choose a time that suits you and pay securely. Your booking is confirmed once payment is verified.",
  },
  {
    title: "Join privately and leave with next steps",
    body: `${DELIVERY.durationMinutes} minutes one to one over Microsoft Teams, followed by a written summary of what to do next.`,
  },
];

export function HowItWorks() {
  return (
    <section
      aria-labelledby="how-heading"
      className="border-line scroll-mt-24 border-b py-20 sm:py-24"
      id="how-it-works"
    >
      <Container>
        <div className="max-w-2xl">
          <SectionLabel>How it works</SectionLabel>
          <h2
            id="how-heading"
            className="text-ink text-3xl font-semibold tracking-[-0.025em] text-balance sm:text-4xl"
          >
            Four steps from choosing a session to doing the work.
          </h2>
        </div>

        <ol className="mt-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <div className="border-line-strong text-ink flex size-9 items-center justify-center rounded-full border text-sm font-semibold tabular-nums">
                {index + 1}
              </div>
              <h3 className="text-ink mt-5 text-base font-semibold tracking-tight">{step.title}</h3>
              <p className="text-ink-muted mt-2.5 text-sm leading-relaxed">{step.body}</p>
            </li>
          ))}
        </ol>

        <p className="text-ink-faint border-line mt-14 border-t pt-8 text-sm leading-relaxed">
          {DELIVERY.availability}. Times are shown in your own timezone alongside{" "}
          {DELIVERY.timezoneLabel}.
        </p>
      </Container>
    </section>
  );
}
