# AI Training Platform

Marketing site and booking engine for a private 1-to-1 AI training and
implementation practice based in Dubai.

One Next.js application serves two surfaces on a single domain:

```
/            parent company site
/training    landing page + booking engine
```

> **Status: in development.** Not deployed, not taking payments, holding no real
> customer data. Company identity is intentionally unset, so the site renders
> visible `[COMPANY_NAME]`-style placeholders and serves `Disallow: /` until real
> values exist.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.3 (App Router, Turbopack), React 19, TypeScript strict |
| Styling | Tailwind v4, design tokens in `src/app/globals.css` |
| Database | Supabase Postgres |
| Payments | Stripe Checkout, webhook-authoritative |
| Scheduling | Microsoft Graph Calendar API |
| Email | Resend |
| Jobs | Supabase Cron → authenticated API route |
| Hosting | Managed Node.js host |

The application is deliberately **host-agnostic**: no provider-proprietary
runtime services, so it can move hosts without a rewrite.

## Getting started

The runtimes are declared in the repository, not in your shell profile:
**Node** in `.nvmrc`, **pnpm** in `package.json` under `packageManager`. A
version manager that reads `.nvmrc` (fnm, nvm, asdf) plus Corepack will put
you on exactly what CI and the host run — which is the point, because a local
toolchain that differs from CI cannot be verified by CI.

```bash
corepack enable              # once per machine; lets pnpm match the pinned version
fnm use                      # or `nvm use` - reads .nvmrc
pnpm install
cp .env.example .env.local   # fill in what you need; nothing is required to run the site
pnpm dev                     # http://localhost:3000/training
```

## Commands

| Command | Purpose |
|---|---|
| `pnpm verify` | Full gate: format, lint, types, security guards, tests + coverage, build |
| `pnpm dev` | Development server |
| `pnpm build` | Production build |
| `pnpm test` | Unit tests |
| `pnpm test:coverage` | Tests with coverage thresholds enforced |
| `pnpm check:security` | Project security guards |

`pnpm verify` is what CI runs. If it passes locally it should pass on push.

## Architecture notes

**Prices have exactly one source of truth.** `src/config/sessions.ts` defines the
catalogue; `src/domain/pricing/resolve-price.ts` maps a slug to an approved price
record server-side. A price submitted by a client is never trusted, and a guard
script fails the build if a price is constructed anywhere else.

**Money is integer fils**, never floating point — which is also the unit Stripe
expects, so it passes straight through.

**Payment and scheduling are separate concerns.** An `Order` is one payment; it
owns one or more `Booking` rows, each a scheduled session. Payment state lives
only on the order, scheduling state only on the booking.

**Timestamps are stored in UTC** and rendered in the viewer's timezone with a
Gulf Standard Time reference.

**Session detail is deep-linkable** — `/training#ai-agents` opens that session's
panel. Built on native `<details>` with a small hash handler, so it degrades
gracefully without JavaScript.

## Security

See [SECURITY.md](./SECURITY.md) for controls and how to report a vulnerability.

Briefly: every GitHub Action is pinned to a commit SHA, workflows run with
least-privilege permissions, and CI layers secret scanning, dependency auditing,
CodeQL and an OWASP ZAP baseline scan against a real running build. Eight
project-specific guards enforce invariants a linter cannot express, and each
guard is itself unit tested.

## Testing

```bash
pnpm test:coverage
```

Coverage is scoped to logic modules — configuration, domain and library code —
rather than React components, which are exercised by the production build and by
DAST. Thresholds act as a ratchet: they may be raised, never lowered to make a
build pass.

## Licence

Proprietary. All rights reserved.
