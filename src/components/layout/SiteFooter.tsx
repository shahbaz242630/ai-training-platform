import Link from "next/link";
import { Container } from "@/components/ui/Container";
import {
  companyName,
  legalEntityName,
  supportEmail,
  FOOTER_LINKS,
  SITE,
  DELIVERY,
} from "@/config/site";

export function SiteFooter() {
  return (
    <footer className="border-line bg-canvas border-t">
      <Container className="py-14">
        <div className="flex flex-col gap-10 sm:flex-row sm:justify-between">
          <div className="max-w-sm">
            <p className="text-ink text-[15px] font-semibold tracking-tight">{companyName()}</p>
            <p className="text-ink-muted mt-3 text-sm leading-relaxed">
              Private 1-to-1 AI training and implementation coaching. {SITE.serviceArea}.
            </p>
            <p className="text-ink-faint mt-4 text-sm">{supportEmail()}</p>
          </div>

          <nav aria-label="Legal" className="flex flex-col gap-3">
            {FOOTER_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-ink-muted hover:text-ink text-sm transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="border-line mt-12 border-t pt-8">
          <p className="text-ink-faint text-xs leading-relaxed">
            {DELIVERY.format}. Sessions are coaching and mentoring; no qualification or award is
            issued.
          </p>
          <p className="text-ink-faint mt-2 text-xs">
            &copy; {new Date().getFullYear()} {legalEntityName()}. All rights reserved.
          </p>
        </div>
      </Container>
    </footer>
  );
}
