import Link from "next/link";
import { Container } from "@/components/ui/Container";
import { ZaaheenMark } from "@/components/brand/ZaaheenMark";
import { companyName, COMPANY_NAV_LINKS, COMPANY_SITE_URL, TRAINING_BASE } from "@/config/site";

/**
 * The company site's top bar, so the booking pages read as part of zaaheen.com
 * rather than a separate website. The name and the three tabs lead back to the
 * company site; only "Book a session" stays inside this app.
 *
 * Plain anchors, not next/link: client-side navigation only works within this
 * app, and these links leave it. The Knowledge Centre tab is shown as current,
 * because coaching is what that tab leads to.
 */
export function SiteHeader() {
  return (
    <header className="border-line sticky top-0 z-50 border-b bg-[rgba(250,248,243,.88)] backdrop-blur-md">
      <Container>
        <div className="grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 py-2.5 md:grid-cols-[1fr_auto_1fr] md:gap-x-7 md:py-2">
          <a
            href={`${COMPANY_SITE_URL}/`}
            className="text-ink flex items-center gap-2.5 justify-self-start"
          >
            <span className="md:hidden">
              <ZaaheenMark size={36} />
            </span>
            <span className="hidden md:inline">
              <ZaaheenMark size={48} />
            </span>
            <span className="font-serif text-[19px] font-medium md:text-[21px]">
              {companyName()}
            </span>
          </a>

          {/* On a phone the tabs take their own row under the name and the button. */}
          <nav
            aria-label="Zaaheen"
            className="order-last col-span-2 flex items-center gap-x-6 gap-y-1 justify-self-start md:order-none md:col-span-1 md:gap-x-8 md:justify-self-center"
          >
            {COMPANY_NAV_LINKS.map((link) => {
              const current = link.label === "Knowledge Centre";
              return (
                <a
                  key={link.href}
                  href={link.href}
                  aria-current={current ? "page" : undefined}
                  className={`text-[15px] transition-colors ${
                    current ? "text-ink font-medium" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {link.label}
                </a>
              );
            })}
          </nav>

          {/* The full path, so it also works from the policy and booking pages. */}
          <Link
            href={`${TRAINING_BASE}#sessions`}
            className="bg-ink text-on-deep hover:bg-deep-soft justify-self-end rounded-full px-[18px] py-2 text-sm font-medium whitespace-nowrap transition-colors"
          >
            Book a session
          </Link>
        </div>
      </Container>
    </header>
  );
}
