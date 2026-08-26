import { SITE, isPubliclyConfigured, type SitePlaceholders } from "@/config/site";
import { getActiveSessions } from "@/config/sessions";
import { filsToAed } from "@/lib/money";

/**
 * Structured data is emitted ONLY when the real company identity exists.
 *
 * Publishing schema containing "[COMPANY_NAME]" would be worse than publishing
 * none: it puts placeholder data into search and answer engines as though it
 * were fact. Schema must also truthfully match visible content, so there are
 * no ratings, no reviews and no aggregate claims here.
 */
export function buildTrainingJsonLd(site: SitePlaceholders = SITE): string | null {
  if (!isPubliclyConfigured(site)) return null;

  const origin = `https://${site.domain}`;

  const organization = {
    "@type": "Organization",
    "@id": `${origin}/#organization`,
    name: site.companyName,
    legalName: site.legalEntityName,
    url: origin,
    areaServed: site.serviceArea,
  };

  const services = getActiveSessions().map((session) => ({
    "@type": "Service",
    name: session.title,
    description: session.summary,
    serviceType: "AI training and implementation coaching",
    provider: { "@id": `${origin}/#organization` },
    areaServed: site.serviceArea,
    offers: {
      "@type": "Offer",
      price: filsToAed(session.priceFils).toFixed(2),
      priceCurrency: "AED",
      url: `${origin}/training#${session.slug}`,
    },
  }));

  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [organization, ...services],
  });
}
