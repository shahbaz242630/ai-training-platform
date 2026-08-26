import type { Metadata } from "next";
import { SiteHeader } from "@/components/layout/SiteHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { Hero } from "@/components/training/Hero";
import { Progression } from "@/components/training/Progression";
import { SessionCatalogue } from "@/components/training/SessionCatalogue";
import { Differentiators } from "@/components/training/Differentiators";
import { HowItWorks } from "@/components/training/HowItWorks";
import { Faq } from "@/components/training/Faq";
import { FinalCta } from "@/components/training/FinalCta";

export const metadata: Metadata = {
  title: "Private 1-to-1 AI Training — Dubai",
  description:
    "Practical private AI sessions in Dubai for professionals, founders and builders. Research and prompting, ChatGPT and Codex, Claude Code, AI agents, technology stacks and production deployment. Evening appointments available.",
  alternates: { canonical: "/training" },
  openGraph: {
    title: "Learn how to work with AI — not just talk to it",
    description:
      "Private 1-to-1 practical AI training and implementation coaching in Dubai. Evening sessions, 90 minutes, online.",
    type: "website",
  },
};

/**
 * NOTE - structured data is intentionally NOT emitted yet.
 *
 * `buildTrainingJsonLd()` in @/lib/structured-data is written and tested, but it
 * returns null until the real company identity exists, so there is nothing
 * truthful to publish today. Wiring the <script> tag is a launch task, together
 * with choosing a safe serialisation approach for the JSON-LD payload.
 */
export default function TrainingPage() {
  return (
    <>
      <a
        href="#main"
        className="bg-ink sr-only rounded-lg px-4 py-2 text-sm font-semibold text-white focus:not-sr-only focus:absolute focus:top-4 focus:left-4 focus:z-100"
      >
        Skip to content
      </a>

      <SiteHeader />
      <main id="main">
        <Hero />
        <Progression />
        <SessionCatalogue />
        <Differentiators />
        <HowItWorks />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </>
  );
}
