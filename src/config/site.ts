/**
 * Company-level configuration.
 *
 * CRITICAL: values that are not yet real are `null`.
 * They render as visible bracketed placeholders such as [COMPANY_NAME] so an
 * unfilled value is obvious rather than silently invented, and structured data
 * is suppressed entirely until the real values exist. Never replace a null here
 * with a plausible-sounding guess.
 */

export interface SitePlaceholders {
  readonly companyName: string | null;
  readonly legalEntityName: string | null;
  readonly domain: string | null;
  readonly supportEmail: string | null;
  readonly phone: string | null;
  readonly instructorName: string | null;
  readonly instructorBio: string | null;
  readonly serviceArea: string;
}

export const SITE: SitePlaceholders = {
  companyName: null,
  legalEntityName: null,
  domain: null,
  supportEmail: null,
  phone: null,
  instructorName: null,
  instructorBio: null,
  serviceArea: "Dubai, United Arab Emirates",
};

/** Renders a real value, or a visible placeholder token if not yet supplied. */
export function placeholder(value: string | null, token: string): string {
  return value ?? `[${token}]`;
}

export const companyName = () => placeholder(SITE.companyName, "COMPANY_NAME");
export const instructorName = () => placeholder(SITE.instructorName, "INSTRUCTOR_NAME");
export const supportEmail = () => placeholder(SITE.supportEmail, "SUPPORT_EMAIL");

/**
 * True only when every value needed for truthful public schema is real.
 *
 * Takes the site as a parameter so the configured branch is reachable in tests
 * without mutating a module-level constant - this gates what we publish about
 * ourselves, so it must be verifiable rather than merely inspected.
 */
export function isPubliclyConfigured(site: SitePlaceholders = SITE): boolean {
  return Boolean(site.companyName && site.domain && site.legalEntityName);
}

export type SiteEnv = "development" | "staging" | "production";

/**
 * Whether this deployment may be indexed by search and answer engines.
 *
 * BOTH conditions must hold, and for different reasons:
 *
 *  - **Production only.** Staging runs on a throwaway host domain. If it were
 *    indexed we would be competing against our own real domain with duplicate
 *    content, and removing a domain from an index is slow and imperfect.
 *  - **Real identity.** Placeholder content such as "[COMPANY_NAME]" must never
 *    be cached by a search or answer engine as though it were fact.
 *
 * Fails safe: anything other than an explicit production build is not indexable.
 */
export function isIndexable(siteEnv: SiteEnv, site: SitePlaceholders = SITE): boolean {
  return siteEnv === "production" && isPubliclyConfigured(site);
}

export const TRAINING_BASE = "/training";

export const NAV_LINKS = [
  { href: "#sessions", label: "Sessions" },
  { href: "#how-it-works", label: "How it works" },
  { href: "#faq", label: "FAQ" },
] as const;

export const FOOTER_LINKS = [
  { href: "/training/privacy", label: "Privacy" },
  { href: "/training/terms", label: "Terms" },
  { href: "/training/refunds-cancellations", label: "Refunds & cancellations" },
] as const;

/**
 * Delivery facts. These are commitments made to customers, so they live in one
 * place rather than being restated in copy where they can drift apart.
 */
export const DELIVERY = {
  format: "Private 1-to-1, online via Microsoft Teams",
  durationMinutes: 90,
  availability: "Evenings, Monday to Thursday, plus selected weekend slots",
  timezoneLabel: "Gulf Standard Time (UTC+4)",
} as const;
