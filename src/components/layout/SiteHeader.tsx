import Link from "next/link";
import { Container } from "@/components/ui/Container";
import { ButtonLink } from "@/components/ui/Button";
import { companyName, NAV_LINKS } from "@/config/site";

export function SiteHeader() {
  return (
    <header className="border-line bg-canvas/85 sticky top-0 z-50 border-b backdrop-blur-md">
      <Container>
        <div className="flex h-16 items-center justify-between gap-6 sm:h-20">
          <Link
            href="/training"
            className="text-ink text-[15px] font-semibold tracking-tight whitespace-nowrap"
          >
            {companyName()}
          </Link>

          <nav aria-label="Sections" className="hidden items-center gap-8 md:flex">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-ink-muted hover:text-ink text-sm font-medium transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <ButtonLink href="#sessions" className="!px-5 !py-2.5 text-[13px]">
            Book a session
          </ButtonLink>
        </div>
      </Container>
    </header>
  );
}
