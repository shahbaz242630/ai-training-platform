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
      include: ["src/config/**", "src/domain/**", "src/data/**", "src/lib/**", "scripts/*.mjs"],
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
      ],
      /*
        Set just below measured coverage so they act as a ratchet: coverage can
        go up freely, but a change that drops it fails the build. Raise these
        deliberately when real coverage rises - never lower them to go green.
      */
      thresholds: {
        lines: 91,
        functions: 91,
        branches: 92,
        statements: 90,
      },
    },
  },
});
