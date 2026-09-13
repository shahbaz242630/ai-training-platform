import { Container } from "@/components/ui/Container";
import { ButtonLink } from "@/components/ui/Button";
import { companyName, COMPANY_NAV_LINKS, COMPANY_SITE_URL, TRAINING_BASE } from "@/config/site";

/**
 * The company site's top bar, so the booking pages read as part of zaaheen.com
 * rather than a separate website. The name and the three tabs lead back to the
 * company site; only "Book a session" stays inside this app.
 *
 * Plain anchors, not next/link: client-side navigation only works within this
 * app, and these links leave it.
 */
export function SiteHeader() {
  return (
    <header className="border-line bg-canvas/85 sticky top-0 z-50 border-b backdrop-blur-md">
      <Container>
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 md:h-20 md:flex-nowrap md:py-0">
          <a
            href={`${COMPANY_SITE_URL}/`}
            className="text-ink text-[15px] font-semibold tracking-tight whitespace-nowrap"
          >
            {companyName()}
          </a>

          {/* On a phone the tabs take their own row under the name and the button. */}
          <nav
            aria-label="Zaaheen"
            className="order-last flex w-full items-center gap-6 md:order-none md:w-auto md:gap-8"
          >
            {COMPANY_NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="text-ink-muted hover:text-ink text-sm font-medium transition-colors"
              >
                {link.label}
              </a>
            ))}
          </nav>

          {/* The full path, so it also works from the policy and booking pages. */}
          <ButtonLink href={`${TRAINING_BASE}#sessions`} className="!px-5 !py-2.5 text-[13px]">
            Book a session
          </ButtonLink>
        </div>
      </Container>
    </header>
  );
}
