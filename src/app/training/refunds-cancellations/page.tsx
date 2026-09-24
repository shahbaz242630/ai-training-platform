import type { Metadata } from "next";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { Container } from "@/components/ui/Container";

export const metadata: Metadata = {
  title: "Refunds & Cancellations",
  robots: { index: false, follow: false },
};

export default function RefundsPage() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="py-20 sm:py-24">
        <Container>
          <div className="max-w-2xl">
            <h1 className="text-ink font-serif text-[clamp(32px,4vw,44px)] leading-[1.12] font-[450] tracking-[-0.015em]">
              Refunds & Cancellations
            </h1>
            <div className="bg-raised border-line mt-8 rounded-2xl border p-6">
              <p className="text-ink text-sm font-medium">Awaiting approved copy</p>
              <p className="text-ink-muted mt-3 text-sm leading-relaxed">
                This page will contain <code className="text-ink">[REFUND_POLICY]</code>.
              </p>
              <p className="text-ink-muted mt-3 text-sm leading-relaxed">
                This policy must be visible before any payment is taken, and must cover reschedule
                and cancellation cut-offs, no-shows, refunds and business-initiated cancellations.
              </p>
            </div>
          </div>
        </Container>
      </main>
      <SiteFooter />
    </>
  );
}
