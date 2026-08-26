# Security

How this project is defended, what is deliberately not defended yet, and how to
report a problem. Written to be honest rather than reassuring - an unlisted gap
is far more dangerous than a documented one.

## Reporting a vulnerability

Do not open a public issue. Report privately to `[SUPPORT_EMAIL]`, or via GitHub
private vulnerability reporting on this repository. Please include what you
found, how to reproduce it, and what you think the impact is.

## What this application handles

| Data | Sensitivity | Where it lives |
|---|---|---|
| Customer name, email, timezone | Personal data | Supabase Postgres |
| Session goals and project notes (intake) | Potentially commercially sensitive | Supabase Postgres |
| Payment | **Never touches our servers** | Stripe hosted Checkout |
| Calendar and meeting links | Business data | Microsoft 365 via Graph |

We never store card details. Stripe hosted Checkout means card data does not
reach our infrastructure at any point.

## Controls in place

### Pipeline
- **Every GitHub Action pinned to a commit SHA**, never a tag. Tags are mutable;
  a compromised action repository could otherwise execute arbitrary code in our
  pipeline with our secrets. Enforced by `pnpm check:security`.
- **Least-privilege workflow permissions** - `contents: read` by default, with
  jobs opting in only where required.
- **`--frozen-lockfile`** everywhere, so CI can never silently resolve a
  different dependency tree than the one reviewed.
- **Gitleaks** secret scanning over full history, because a secret removed in a
  later commit is still exposed in the one that introduced it.
- **CodeQL** with `security-extended` queries.
- **Dependency audit** - high and critical advisories in *production*
  dependencies fail the build; dev-only advisories report without blocking.
- **OWASP ZAP baseline** DAST against a real running build, because a missing
  security header is invisible to static analysis.
- **Weekly scheduled re-scan** - code that never changes still becomes
  vulnerable when advisories are published against its dependencies.

### Application
- **Security headers** on every response: HSTS, `X-Content-Type-Options`,
  `Referrer-Policy`, `Permissions-Policy`, and a Content Security Policy with
  `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`.
- **Server-side price resolution.** A price submitted by a client is never
  trusted; the server maps a slug to an approved price record.
- **Stripe webhook signature verification** is mandatory and enforced by test.
- **Idempotent webhook handling** keyed on the Stripe event ID.
- **Redacting logger** - tokens, keys, card fields, cookies and authorization
  headers are stripped before anything is written.
- **Audit trail** for booking and payment events.
- **Zod validation** on every external input, server-side.
- **Secrets are server-only.** Nothing sensitive sits behind `NEXT_PUBLIC_*`;
  a guard script fails the build if it does.

### Repository
- `main` is protected: pull request required, CI must pass, force-push and
  deletion blocked.
- Production deployment gated behind a protected environment.

## Status

This application is **not yet live**. It handles no real customer data, takes no
payments, and has no production deployment.

Known weaknesses are tracked internally and reviewed before launch, rather than
enumerated here. One is worth stating publicly because it is observable from any
response header anyway: the Content Security Policy currently permits
`'unsafe-inline'` for scripts, because the Next.js App Router injects inline
hydration scripts into statically prerendered pages. Moving to a nonce-based
policy is planned alongside the dynamic checkout routes.

Rate limiting and bot protection arrive with the first public write endpoints;
there are none today.

## Handling a leaked secret

Rotate first, investigate second. Removing a secret from git history does not
un-leak it - anyone who cloned the repository still has it.

1. Revoke the credential at the provider immediately.
2. Issue a replacement and update the deployment environment.
3. Only then clean history if warranted.
4. Check provider logs for use between exposure and revocation.
