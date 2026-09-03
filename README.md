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
| Email | Microsoft Graph, sent from the booking mailbox |
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
| `pnpm db:check` | Read-only: is the database current with `supabase/migrations`? Non-zero exit if not |
| `pnpm db:migrate` | Apply every pending migration, in order, each in its own transaction |

`pnpm verify` is what CI runs. If it passes locally it should pass on push.

## Database migrations

Schema changes live in `supabase/migrations`, one file per change, named
`YYYYMMDDHHMMSS_short_name.sql`. `pnpm db:migrate` applies them in that order,
each in its own transaction, and records each one in a `schema_migrations`
ledger together with a checksum of the file as applied. `pnpm db:check` is
read-only and exits non-zero when anything is pending or the history has
drifted, so it can gate a deploy.

Both read `DATABASE_URL` and `DATABASE_CA_CERT` from the environment, or from
`.env.local` locally. Run them once per environment: each database keeps its
own ledger.

A file edited after it was applied is reported as drift and blocks further
migrations, because a file that no longer matches what the database did is a
false record. Write a new migration instead. `pnpm db:migrate --mark-applied FILE`
exists for one case only, a schema that was applied by hand before the ledger
existed, and is never a way to skip a migration.

The test suite also applies every migration to an in-process Postgres and then
attempts each constraint it adds, so a migration is verified before it is
merged, not only when it is run.

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


**Every message a customer is owed is a row first.** Settlement and confirmation
queue rows in `communication_log` with a template key and a due time in UTC; a
job called every five minutes claims what is due, renders the current template,
sends it, and records the result. A failed send is retried with backoff and then
left for a person, and never breaks a booking. The provider is handed the row id
as an idempotency key, so a retry after a crash cannot deliver twice. Email goes
through a port with a real adapter and an in-memory one; there is no fallback to
the in-memory one when the real one is unconfigured, because a message marked
sent into memory is a customer recorded as told when they were told nothing.

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
