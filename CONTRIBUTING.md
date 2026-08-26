# Contributing

## Branching

`main` is protected and always deployable. Nothing is pushed to it directly —
including by administrators, which is enforced rather than assumed.

```
feature branch  →  pull request  →  CI + staging  →  squash merge to main  →  production
```

Branch names: `feat/…`, `fix/…`, `chore/…`, `docs/…`, `refactor/…`.
Keep them short-lived. A branch open for a week is a merge conflict in waiting.

## Pull requests

Every change goes through a PR, however small. The PR is where the checks run,
and it is the record of why a change was made.

Seven checks must pass before merge:

| Check | What it protects |
|---|---|
| Format, lint and types | Consistency and type safety |
| Unit tests and coverage | Behaviour, with thresholds as a ratchet |
| Repository security guards | Project invariants a linter cannot express |
| Production build | That it actually builds |
| Secret scan | No credential reaches the history |
| Dependency audit | No high or critical advisory in production dependencies |
| CodeQL | Static security analysis |

An OWASP ZAP baseline scan also runs on pull requests. It is intentionally
**not** a required check: DAST is slower and more prone to environmental flakes
than the gates above, so it informs review rather than blocking it. High-severity
findings still fail that workflow and should be treated as blocking in practice.

Merges are **squash only**, and `main` keeps a linear history — so every commit
on `main` is one reviewed change and stays a valid rollback target.

## Releasing

- `staging` deploys from `main` automatically.
- `production` requires manual approval and deploys only from `main`.

## Before you open a PR

```bash
pnpm verify
```

That runs the same gate as CI: format, lint, types, security guards, tests with
coverage, and a production build. If it passes locally it should pass on push.

## Conventions that are not negotiable

- **A booking is confirmed only by a verified payment webhook**, never because a
  browser reached a success page.
- **Prices are resolved server-side.** A price submitted by a client is never
  trusted.
- **Secrets are server-side only** and never behind `NEXT_PUBLIC_*`.
- **Timestamps are stored in UTC.**
- **Never invent** testimonials, client names, statistics, credentials or legal
  statements. Placeholders stay visible until real values are supplied.
