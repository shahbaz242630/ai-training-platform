import { Container } from "@/components/ui/Container";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { FAQS } from "@/config/faqs";

export function Faq() {
  return (
    <section
      aria-labelledby="faq-heading"
      className="border-line scroll-mt-24 border-b py-20 sm:py-24"
      id="faq"
    >
      <Container>
        <div className="grid gap-12 lg:grid-cols-[22rem_1fr] lg:gap-20">
          <div>
            <SectionLabel>Questions</SectionLabel>
            <h2
              id="faq-heading"
              className="text-ink text-3xl font-semibold tracking-[-0.025em] text-balance sm:text-4xl"
            >
              Before you book.
            </h2>
          </div>

          <div>
            {FAQS.map((faq) => (
              <details key={faq.id} id={faq.id} className="group border-line border-b">
                <summary className="flex items-start justify-between gap-6 py-5 text-left">
                  <span className="text-ink group-hover:text-accent text-[15px] font-medium transition-colors">
                    {faq.question}
                  </span>
                  <svg
                    className="text-ink-faint mt-1 size-4 shrink-0 transition-transform group-open:rotate-45"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <path
                      d="M8 3v10M3 8h10"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </summary>
                <p className="text-ink-muted max-w-2xl pb-6 text-sm leading-relaxed">
                  {faq.answer}
                </p>
              </details>
            ))}
          </div>
        </div>
      </Container>
    </section>
  );
}
