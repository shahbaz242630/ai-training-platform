import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
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
      include: ["src/config/**", "src/domain/**", "src/lib/**", "scripts/*.mjs"],
      // Thin process wrappers with no branching logic of their own. Excluded
      // rather than counted, so the percentage keeps describing code where a
      // regression could actually change behaviour.
      exclude: [
        "**/*.test.*",
        "src/lib/env.ts",
        "scripts/check-zap-report.mjs",
        "scripts/build.mjs",
      ],
      /*
        Set just below measured coverage so they act as a ratchet: coverage can
        go up freely, but a change that drops it fails the build. Raise these
        deliberately when real coverage rises - never lower them to go green.
      */
      thresholds: {
        lines: 86,
        functions: 85,
        branches: 85,
        statements: 83,
      },
    },
  },
});
