import Link from "next/link";
import { Container } from "@/components/ui/Container";
import { ZaaheenMark } from "@/components/brand/ZaaheenMark";
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
      <Container className="pt-14 pb-10">
        <div className="flex flex-col gap-10 sm:flex-row sm:justify-between">
          <div className="max-w-[380px]">
            <p className="text-ink flex items-center gap-2.5">
              <ZaaheenMark size={36} />
              <span className="font-serif text-[19px] font-medium">{companyName()}</span>
            </p>
            <p className="text-ink-muted mt-3 text-[14.5px] leading-relaxed">
              Private 1-to-1 AI training and implementation coaching. {SITE.serviceArea}.
            </p>
            <p className="text-ink-faint mt-3 font-mono text-[13px]">{supportEmail()}</p>
          </div>

          <nav aria-label="Legal" className="flex flex-col gap-3">
            {FOOTER_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-ink-muted hover:text-ink text-[14.5px] transition-colors"
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="border-line mt-10 border-t pt-6">
          <p className="text-ink-faint text-[13px] leading-relaxed">
            {DELIVERY.format}. Sessions are coaching and mentoring; no qualification or award is
            issued.
          </p>
          <p className="text-ink-faint mt-1.5 text-[13px]">
            &copy; {new Date().getFullYear()} {legalEntityName()}. All rights reserved.
          </p>
        </div>
      </Container>
    </footer>
  );
}
