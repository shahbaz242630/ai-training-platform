import type { Metadata } from "next";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { Container } from "@/components/ui/Container";

export const metadata: Metadata = {
  title: "Terms",
  robots: { index: false, follow: false },
};

export default function TermsPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="py-20 sm:py-24">
        <Container>
          <div className="max-w-2xl">
            <h1 className="text-ink font-serif text-[clamp(32px,4vw,44px)] leading-[1.12] font-[450] tracking-[-0.015em]">
              Terms
            </h1>
            <div className="bg-raised border-line mt-8 rounded-2xl border p-6">
              <p className="text-ink text-sm font-medium">Awaiting approved copy</p>
              <p className="text-ink-muted mt-3 text-sm leading-relaxed">
                This page will contain <code className="text-ink">[TERMS_APPROVED_COPY]</code>.
              </p>
              <p className="text-ink-muted mt-3 text-sm leading-relaxed">
                Legal text must be written or approved by a qualified adviser. It is deliberately
                not drafted here, and must be in place before booking opens.
              </p>
            </div>
          </div>
        </Container>
      </main>
      <SiteFooter />
    </>
  );
}
