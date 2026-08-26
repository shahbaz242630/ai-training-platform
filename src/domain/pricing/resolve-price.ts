import { AED, type Currency, type Fils } from "@/lib/money";
import { getSessionBySlug } from "@/config/sessions";
import { getPathwayBySlug } from "@/config/pathways";

/**
 * Server-side price resolution.
 *
 * SECURITY RULE: the client never supplies a price. It supplies a
 * slug; the server maps that slug to an approved price record. Any change here
 * changes what customers are charged - treat it as security-critical code.
 */

export type PurchasableKind = "session" | "pathway";

export interface ResolvedPrice {
  readonly kind: PurchasableKind;
  readonly slug: string;
  readonly title: string;
  readonly amountFils: Fils;
  readonly currency: Currency;
  /** Prices are VAT-inclusive. Zero until tax registration takes effect. */
  readonly taxTreatment: "inclusive";
  readonly taxRateBasisPoints: number;
  readonly stripePriceIdEnvKey: string;
}

export class PriceResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceResolutionError";
  }
}

/** 0 until VAT registration; 500 basis points (5%) once a TRN exists. */
const VAT_RATE_BASIS_POINTS = 0;

export function resolvePrice(kind: PurchasableKind, slug: string): ResolvedPrice {
  if (kind === "session") {
    const session = getSessionBySlug(slug);
    if (!session) throw new PriceResolutionError(`Unknown session: "${slug}"`);
    if (!session.active) throw new PriceResolutionError(`Session is not available: "${slug}"`);
    return {
      kind,
      slug: session.slug,
      title: session.title,
      amountFils: session.priceFils,
      currency: AED,
      taxTreatment: "inclusive",
      taxRateBasisPoints: VAT_RATE_BASIS_POINTS,
      stripePriceIdEnvKey: session.stripePriceIdEnvKey,
    };
  }

  const pathway = getPathwayBySlug(slug);
  if (!pathway) throw new PriceResolutionError(`Unknown pathway: "${slug}"`);
  if (!pathway.active) throw new PriceResolutionError(`Pathway is not available: "${slug}"`);
  return {
    kind,
    slug: pathway.slug,
    title: pathway.title,
    amountFils: pathway.pathwayPriceFils,
    currency: AED,
    taxTreatment: "inclusive",
    taxRateBasisPoints: VAT_RATE_BASIS_POINTS,
    stripePriceIdEnvKey: pathway.stripePriceIdEnvKey,
  };
}
