import Link from "next/link";
import type { Metadata } from "next";
import { Container } from "@/components/ui/Container";
import { ButtonLink } from "@/components/ui/Button";
import { companyName, SITE } from "@/config/site";

export const metadata: Metadata = {
  title: "[COMPANY_NAME]",
  description: "AI products and private 1-to-1 AI training, based in Dubai.",
};

/**
 * Parent company shell.
 *
 * Deliberately minimal. It exists now so /training sits at its final URL from
 * day one and the single-domain decision (D1) needs no retrofitting later. The
 * full company site is a later phase.
 */
export default function CompanyHome() {
  return (
    <>
      <main id="main">
        <section className="flex min-h-[70vh] items-center py-24">
          <Container>
            <p className="text-ink-muted mb-6 text-xs font-semibold tracking-[0.18em] uppercase">
              {SITE.serviceArea}
            </p>
            <h1 className="text-ink max-w-3xl text-[2.6rem] leading-[1.05] font-semibold tracking-[-0.035em] text-balance sm:text-[3.5rem]">
              {companyName()}
            </h1>
            <p className="text-ink-muted mt-7 max-w-xl text-lg leading-relaxed">
              We build AI applications, and we teach people how to work with AI properly.
            </p>

            <div className="mt-10 flex flex-col gap-3 sm:flex-row">
              <ButtonLink href="/training">Private 1-to-1 AI training</ButtonLink>
            </div>

            <p className="text-ink-faint mt-16 max-w-xl text-sm leading-relaxed">
              The full company site, including our products, is in development.
            </p>
          </Container>
        </section>
      </main>

      <footer className="border-line border-t py-10">
        <Container>
          <p className="text-ink-faint text-xs">
            &copy; {new Date().getFullYear()} [LEGAL_ENTITY_NAME].{" "}
            <Link href="/training" className="hover:text-ink underline underline-offset-4">
              Training
            </Link>
          </p>
        </Container>
      </footer>
    </>
  );
}
