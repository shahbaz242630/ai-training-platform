import { aedToFils, type Fils } from "@/lib/money";

/**
 * THE single source of truth for the session catalogue and its prices.
 *
 * Rules:
 *  - Prices are never duplicated in components, copy, or Stripe metadata.
 *  - Prices are VAT-INCLUSIVE, so a displayed figure never changes when tax
 *    registration takes effect. The rate lives in the price resolver.
 *  - The server resolves slug -> price record -> Stripe Price ID. A price
 *    submitted by the client is never trusted.
 */

export type SessionLevel = "foundation" | "intermediate" | "advanced";
export type SessionCategory = "training" | "implementation";

export interface SessionType {
  readonly code: "S1" | "S2" | "S3" | "S4" | "S5" | "S6";
  readonly slug: string;
  readonly title: string;
  readonly shortTitle: string;
  readonly summary: string;
  readonly durationMinutes: number;
  readonly priceFils: Fils;
  readonly level: SessionLevel;
  readonly category: SessionCategory;
  readonly audience: string;
  readonly outcome: string;
  readonly topics: readonly string[];
  readonly prerequisites: readonly string[];
  readonly prerequisiteNote?: string;
  readonly active: boolean;
  readonly displayOrder: number;
  /** Populated from env/config once Stripe prices exist. */
  readonly stripePriceIdEnvKey: string;
}

export const SESSIONS: readonly SessionType[] = [
  {
    code: "S1",
    slug: "ai-research-prompting-foundations",
    title: "AI Research, Prompting & Foundations",
    shortTitle: "Research & Foundations",
    summary:
      "Build a reliable method for researching, prompting, structuring and verifying AI work before you start building with it.",
    durationMinutes: 90,
    priceFils: aedToFils(1299),
    level: "foundation",
    category: "training",
    audience: "Professionals who use AI casually and want dependable, repeatable results.",
    outcome: "A repeatable method to research, prompt, structure and validate AI work.",
    topics: [
      "Practical differences between the major AI models",
      "Choosing a model based on the task",
      "AI research workflows",
      "Prompt engineering and context design",
      "Project setup methodology",
      "Documentation and requirements thinking",
      "Memory and context management",
      "Verification and source discipline",
      "Structuring work for AI-assisted building",
    ],
    prerequisites: [],
    active: true,
    displayOrder: 1,
    stripePriceIdEnvKey: "STRIPE_PRICE_S1",
  },
  {
    code: "S2",
    slug: "chatgpt-codex-openai",
    title: "ChatGPT, Codex & OpenAI Workflows",
    shortTitle: "ChatGPT & Codex",
    summary:
      "Use the OpenAI ecosystem as a working and building environment rather than as a chatbot.",
    durationMinutes: 90,
    priceFils: aedToFils(1499),
    level: "intermediate",
    category: "training",
    audience: "People ready to turn ideas into specifications and working output.",
    outcome: "You can run real project and build workflows across the OpenAI ecosystem.",
    topics: [
      "Advanced ChatGPT workflows",
      "Research and project workflows",
      "Codex desktop and CLI where appropriate",
      "Turning an idea into a build specification",
      "Coding-agent workflow",
      "APIs and OpenAI platform concepts",
      "Task handoffs and context management",
      "Iterative build and testing patterns",
    ],
    prerequisites: [],
    active: true,
    displayOrder: 2,
    stripePriceIdEnvKey: "STRIPE_PRICE_S2",
  },
  {
    code: "S3",
    slug: "claude-claude-code",
    title: "Claude, Claude Code & Advanced Workflows",
    shortTitle: "Claude & Claude Code",
    summary:
      "Work effectively in Claude's ecosystem and make informed choices between competing tools.",
    durationMinutes: 90,
    priceFils: aedToFils(1499),
    level: "intermediate",
    category: "training",
    audience: "People working with real codebases, documents or research projects.",
    outcome: "You can use Claude's ecosystem effectively and choose the right tool per task.",
    topics: [
      "Claude workflows",
      "Claude Code",
      "Repository and codebase workflows",
      "Project planning",
      "Coding-agent handoffs",
      "Research and document workflows",
      "Practical differences between Claude and OpenAI tools",
      "Choosing the right ecosystem for a task",
    ],
    prerequisites: [],
    active: true,
    displayOrder: 3,
    stripePriceIdEnvKey: "STRIPE_PRICE_S3",
  },
  {
    code: "S4",
    slug: "ai-agents",
    title: "AI Agents & Autonomous Workflows",
    shortTitle: "AI Agents",
    summary: "Set up and operate useful AI agents rather than simply generating responses.",
    durationMinutes: 90,
    priceFils: aedToFils(1699),
    level: "intermediate",
    category: "training",
    audience: "People who want automation that acts, not just answers.",
    outcome: "You understand how to set up, run and supervise agents that do real work.",
    topics: [
      "Agent versus chatbot versus automation",
      "Agent architecture concepts",
      "Local agents and agent harnesses",
      "Tools and permissions",
      "Memory",
      "Task execution and workflow orchestration",
      "Real-life agent use cases",
      "Safety boundaries and human approval",
    ],
    prerequisites: [],
    active: true,
    displayOrder: 4,
    stripePriceIdEnvKey: "STRIPE_PRICE_S4",
  },
  {
    code: "S5",
    slug: "ai-builder-tech-stack",
    title: "The AI Builder Technology Stack",
    shortTitle: "Builder Tech Stack",
    summary:
      "Understand and evaluate every component needed to build a modern AI-enabled application.",
    durationMinutes: 90,
    priceFils: aedToFils(1899),
    level: "advanced",
    category: "training",
    audience: "Founders and builders who need to understand what they are assembling.",
    outcome: "You can reason about the architecture of a modern AI application end to end.",
    topics: [
      "Modern AI application architecture",
      "Frontend, backend and database separation",
      "GitHub and version control",
      "Docker and local environments",
      "Supabase and backend services",
      "Hosting and deployment platforms",
      "APIs and MCP",
      "Automation tooling",
      "Authentication and security fundamentals",
      "Environments, secrets, monitoring and deployment",
    ],
    prerequisites: [],
    active: true,
    displayOrder: 5,
    stripePriceIdEnvKey: "STRIPE_PRICE_S5",
  },
  {
    code: "S6",
    slug: "production-ai-deployment",
    title: "Production AI Implementation & Deployment",
    shortTitle: "Production Deployment",
    summary: "Work through a real production deployment or implementation with direct guidance.",
    durationMinutes: 90,
    priceFils: aedToFils(2499),
    level: "advanced",
    category: "implementation",
    audience: "People with a real project that needs to reach production safely.",
    outcome: "You move a real project through a production deployment workflow with guidance.",
    topics: [
      "Production readiness and architecture review",
      "Environment configuration",
      "Deployment",
      "Database and backend connectivity",
      "Authentication",
      "Secrets and configuration",
      "Security checks and testing",
      "Logging and error monitoring",
      "Deployment troubleshooting",
      "Safe updates after launch",
    ],
    prerequisites: ["ai-builder-tech-stack"],
    prerequisiteNote:
      "Advanced implementation session - prerequisites apply. Session 5 or equivalent experience is normally required, and depending on the project Sessions 3 and/or 4 may also be needed. This session covers the defined live session, not unlimited engineering work.",
    active: true,
    displayOrder: 6,
    stripePriceIdEnvKey: "STRIPE_PRICE_S6",
  },
];

export function getSessionBySlug(slug: string): SessionType | undefined {
  return SESSIONS.find((s) => s.slug === slug);
}

export function getSessionByCode(code: SessionType["code"]): SessionType | undefined {
  return SESSIONS.find((s) => s.code === code);
}

export function getActiveSessions(): readonly SessionType[] {
  return SESSIONS.filter((s) => s.active).toSorted((a, b) => a.displayOrder - b.displayOrder);
}
