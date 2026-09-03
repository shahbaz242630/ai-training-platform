import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "scripts/**/*.test.mjs",
      // The migrations are applied to a real Postgres and their constraints
      // attempted. SQL that is read and judged correct is not verified SQL.
      "supabase/**/*.test.ts",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "lcov"],
      /*
        Coverage is scoped to logic modules - config, domain, lib and the guard
        scripts. React components are exercised by the production build and by
        DAST rather than unit tests, and including them would produce a
        meaningless global percentage that hides regressions in the code that
        actually decides what a customer is charged.
      */
      include: [
        "src/config/**",
        "src/domain/**",
        "src/data/**",
        "src/lib/**",
        "scripts/*.mjs",
        // The webhook route is the only code that may confirm a payment. It
        // was outside coverage while its three-way outcome branch had no
        // test, so a regression there could not fail the build.
        "src/app/api/webhooks/**",
        // The send job decides which customer gets which message and when to
        // give up. Same reasoning: a regression there must be able to fail the build.
        "src/app/api/cron/send-communications/**",
        // The hold sweep now deletes calendar events and retries confirmations.
        "src/app/api/cron/sweep-holds/**",
      ],
      // Thin process wrappers with no branching logic of their own. Excluded
      // rather than counted, so the percentage keeps describing code where a
      // regression could actually change behaviour.
      exclude: [
        "**/*.test.*",
        "src/lib/env.ts",
        // A connection factory. What it hands out - the repository SQL - is
        // covered against a real Postgres; the pool itself needs a live
        // endpoint and a mock of it would prove nothing.
        "src/data/db.ts",
        "scripts/check-zap-report.mjs",
        "scripts/build.mjs",
        // The migration CLI: argument parsing and a live connection. The logic
        // it calls - migrations.mjs and db-connection.mjs - is covered against
        // an in-process Postgres.
        "scripts/db-migrate.mjs",
        // A wrapper that sets one flag and spawns vitest on the live smoke test.
        "scripts/graph-smoke.mjs",
      ],
      /*
        Set just below measured coverage so they act as a ratchet: coverage can
        go up freely, but a change that drops it fails the build. Raise these
        deliberately when real coverage rises - never lower them to go green.
      */
      thresholds: {
        // Raised 2026-08-31 with the payment port, which arrived at
        // 94.81/93.80/93.20/93.11. Never lowered - if a change drops coverage
        // it removed test value, and that is the thing to fix.
        lines: 93,
        functions: 92,
        branches: 92,
        statements: 92,
      },
    },
  },
});
