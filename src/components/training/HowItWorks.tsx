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
      className="scroll-mt-24 py-16 sm:py-[104px]"
      id="how-it-works"
    >
      <Container>
        <div className="max-w-[640px]">
          <SectionLabel>How it works</SectionLabel>
          <h2
            id="how-heading"
            className="text-ink font-serif text-[clamp(32px,4vw,44px)] leading-[1.12] font-[450] tracking-[-0.015em] text-balance"
          >
            Four steps from choosing a session to doing the work.
          </h2>
        </div>

        <ol className="border-line mt-14 grid gap-10 border-t pt-7 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, index) => (
            <li key={step.title} className="flex flex-col gap-2.5">
              <span className="text-accent font-mono text-[12.5px]" aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              <h3 className="text-ink font-serif text-xl leading-[1.3] font-medium">
                {step.title}
              </h3>
              <p className="text-ink-muted text-[15px] leading-relaxed">{step.body}</p>
            </li>
          ))}
        </ol>

        <p className="text-ink-faint border-line mt-14 border-t pt-7 text-[14.5px] leading-relaxed">
          {DELIVERY.availability}. Times are shown in your own timezone alongside{" "}
          {DELIVERY.timezoneLabel}.
        </p>
      </Container>
    </section>
  );
}
