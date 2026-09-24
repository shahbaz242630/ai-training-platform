import { Container } from "@/components/ui/Container";
import { SectionLabel } from "@/components/ui/SectionLabel";
import { FAQS } from "@/config/faqs";

export function Faq() {
  return (
    <section
      aria-labelledby="faq-heading"
      className="bg-surface border-line scroll-mt-24 border-y py-16 sm:py-[104px]"
      id="faq"
    >
      <Container>
        <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:gap-20">
          <div>
            <SectionLabel>Questions</SectionLabel>
            <h2
              id="faq-heading"
              className="text-ink font-serif text-[clamp(32px,4vw,44px)] leading-[1.12] font-[450] tracking-[-0.015em] text-balance"
            >
              Before you book.
            </h2>
          </div>

          <div className="border-line min-w-0 border-t">
            {FAQS.map((faq) => (
              <details key={faq.id} id={faq.id} className="group border-line border-b">
                <summary className="flex items-start justify-between gap-6 py-5 text-left">
                  <span className="text-ink group-hover:text-accent text-base font-medium transition-colors">
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
                <p className="text-ink-muted animate-z-in max-w-[680px] pb-[22px] text-[15px] leading-[1.65]">
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
