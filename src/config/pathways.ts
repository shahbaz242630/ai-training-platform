import { aedToFils, type Fils } from "@/lib/money";
import { getSessionBySlug, type SessionType } from "@/config/sessions";

/**
 * Two-session pathways. Retained in config so the commercial construct survives,
 * but v1 sells single sessions only - `active` stays false until the pathway UI
 * and two-slot scheduling exist.
 *
 * Business rule: a pathway is exactly TWO logically connected sessions.
 */
export interface Pathway {
  readonly slug: string;
  readonly title: string;
  readonly sessionSlugs: readonly [string, string];
  readonly pathwayPriceFils: Fils;
  readonly description: string;
  readonly active: boolean;
  readonly displayOrder: number;
  readonly stripePriceIdEnvKey: string;
}

export const PATHWAYS: readonly Pathway[] = [
  {
    slug: "ai-foundations-pathway",
    title: "AI Foundations Pathway",
    sessionSlugs: ["ai-research-prompting-foundations", "chatgpt-codex-openai"],
    pathwayPriceFils: aedToFils(2499),
    description: "Build the method, then put it to work in the OpenAI ecosystem.",
    active: false,
    displayOrder: 1,
    stripePriceIdEnvKey: "STRIPE_PRICE_PATH_FOUNDATIONS",
  },
  {
    slug: "ai-builder-pathway",
    title: "AI Builder Pathway",
    sessionSlugs: ["chatgpt-codex-openai", "claude-claude-code"],
    pathwayPriceFils: aedToFils(2699),
    description: "Work fluently across both major ecosystems and choose between them.",
    active: false,
    displayOrder: 2,
    stripePriceIdEnvKey: "STRIPE_PRICE_PATH_BUILDER",
  },
  {
    slug: "ai-agents-pathway",
    title: "AI Agents Pathway",
    sessionSlugs: ["claude-claude-code", "ai-agents"],
    pathwayPriceFils: aedToFils(2899),
    description: "Move from assisted work to agents that execute tasks.",
    active: false,
    displayOrder: 3,
    stripePriceIdEnvKey: "STRIPE_PRICE_PATH_AGENTS",
  },
  {
    slug: "ai-systems-pathway",
    title: "AI Systems Pathway",
    sessionSlugs: ["ai-agents", "ai-builder-tech-stack"],
    pathwayPriceFils: aedToFils(3249),
    description: "Understand the systems that agents and applications run on.",
    active: false,
    displayOrder: 4,
    stripePriceIdEnvKey: "STRIPE_PRICE_PATH_SYSTEMS",
  },
  {
    slug: "ai-production-pathway",
    title: "AI Production Pathway",
    sessionSlugs: ["ai-builder-tech-stack", "production-ai-deployment"],
    pathwayPriceFils: aedToFils(3999),
    description: "Go from understanding the stack to running a real deployment.",
    active: false,
    displayOrder: 5,
    stripePriceIdEnvKey: "STRIPE_PRICE_PATH_PRODUCTION",
  },
];

export function getPathwayBySlug(slug: string): Pathway | undefined {
  return PATHWAYS.find((p) => p.slug === slug);
}

/** Sum of the two sessions at their individual prices, for honest comparison. */
export function pathwayStandardPriceFils(pathway: Pathway): Fils {
  return pathway.sessionSlugs.reduce((total, slug) => {
    const session = getSessionBySlug(slug);
    if (!session) throw new Error(`Pathway "${pathway.slug}" references unknown session "${slug}"`);
    return total + session.priceFils;
  }, 0);
}

export function pathwaySessions(pathway: Pathway): readonly SessionType[] {
  return pathway.sessionSlugs.map((slug) => {
    const session = getSessionBySlug(slug);
    if (!session) throw new Error(`Pathway "${pathway.slug}" references unknown session "${slug}"`);
    return session;
  });
}
