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
  // The trading name, and the legal name exactly as the Dubai trade licence prints it
  // (licence 1651252, read 2026-09-25). The licence is home-based with no business
  // address; the founder's personal phone and email are never published.
  companyName: "Zaaheen",
  legalEntityName: "Zaaheen Artificial Intelligence Developing Services",
  domain: "coaching.zaaheen.com",
  // The Knowledge Centre mailbox receives every coaching booking (founder, 2026-09-25).
  supportEmail: "knowledgecentre@zaaheen.com",
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
export const legalEntityName = () => placeholder(SITE.legalEntityName, "LEGAL_ENTITY_NAME");
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
  /*
    EVERY field that renders on a public page, not the three most obvious ones.

    This used to check companyName, domain and legalEntityName. Those are the
    natural first three to fill in - and doing so armed indexing while
    supportEmail and instructorName were still null, so a crawler would take
    `[SUPPORT_EMAIL]` in the footer straight into a search result. The guard
    had a blind spot exactly where it mattered, which is worse than no guard,
    because it reads as one.

    A field belongs in this list when it can appear on a page a search engine
    may crawl. Adding a new rendered placeholder means adding it here, and the
    indexing test fails if a token can reach an indexable page.

    instructorName left the list on 2026-09-25: no page renders it, and the
    founder chose not to publish a coach name or bio for now, so it held
    indexing back for nothing. content.test.ts fails the moment anything
    renders it, which is when it must come back here.
  */
  return Boolean(site.companyName && site.domain && site.legalEntityName && site.supportEmail);
}

/**
 * What every page tells search and answer engines: never index, but follow
 * the links (they lead back to zaaheen.com).
 *
 * The booking desk only (founder, 2026-09-27). The page people find for
 * coaching is the Knowledge Centre on zaaheen.com, which lists the same
 * sessions and prices; this app is where its "Book your session" buttons land.
 * Indexing both would put two copies of the same offer in competition, each
 * weaker than one. The same in every environment, so staging (a throwaway host
 * domain) and placeholder identity are covered too. Replaces isIndexable,
 * which armed indexing in production once the identity was real.
 */
export const SEARCH = { index: false, follow: true } as const;

/** The licence, as the company site's footer states it. */
export const LICENCE = "Dubai trade licence 1651252";

export const TRAINING_BASE = "/training";

/**
 * The way back to the rest of Zaaheen.
 *
 * This app runs on its own sub-address (coaching.zaaheen.com); the company site
 * is a separate build at zaaheen.com. The header mirrors that site's top bar -
 * same labels, same order - so moving between the two reads as one website.
 * The URLs are absolute because they leave this host, and end in a slash
 * because that is the company site's canonical form (no redirect hop).
 */
export const COMPANY_SITE_URL = "https://zaaheen.com";

export const COMPANY_NAV_LINKS = [
  { href: `${COMPANY_SITE_URL}/products/`, label: "Products" },
  { href: `${COMPANY_SITE_URL}/docs/`, label: "Documents" },
  { href: `${COMPANY_SITE_URL}/knowledge-centre/`, label: "Knowledge Centre" },
] as const;

/**
 * The coaching policies, published once on the company site beside the
 * Knowledge Centre (the old /training/* addresses redirect there; see
 * next.config.mjs). Linked straight to their final address, so no hop.
 */
export const POLICY_LINKS = {
  terms: `${COMPANY_SITE_URL}/knowledge-centre/terms/`,
  bookingAndRefunds: `${COMPANY_SITE_URL}/knowledge-centre/booking-and-refunds/`,
  privacy: `${COMPANY_SITE_URL}/knowledge-centre/privacy/`,
} as const;

/**
 * The approved booking rules (Booking and Refund Policy). Every screen, email
 * and FAQ that states one of these numbers reads it from here, so the copy a
 * customer agrees to can never drift from the published policy.
 */
export const BOOKING_POLICY = {
  /** A session can be moved only if asked at least this long before it starts. */
  moveNoticeHours: 24,
  /** A moved session goes to an open time within this many days of the original. */
  moveWindowDays: 90,
  /** Not joined this long after the start: the session counts as used. */
  noShowMinutes: 15,
  /** UK and EU consumers' statutory cancellation period. */
  cancellationDays: 14,
  /** After a withdrawal, the refund reaches the card within this many days. */
  withdrawalRefundDays: 14,
} as const;

export const FOOTER_LINKS = [
  { href: POLICY_LINKS.terms, label: "Coaching Terms" },
  { href: POLICY_LINKS.bookingAndRefunds, label: "Booking and Refund Policy" },
  { href: POLICY_LINKS.privacy, label: "Privacy Notice" },
  // The law asks for the withdrawal function to be easy to find the whole time.
  { href: `${TRAINING_BASE}/book/withdraw`, label: "Withdraw from contract here" },
] as const;

/**
 * Delivery facts. These are commitments made to customers, so they live in one
 * place rather than being restated in copy where they can drift apart.
 */
export const DELIVERY = {
  format: "Private 1-to-1, online via Microsoft Teams",
  durationMinutes: 90,
  availability: "Every evening, seven days a week, starting at 7pm or 9pm Dubai time",
  timezoneLabel: "Gulf Standard Time (UTC+4)",
} as const;
