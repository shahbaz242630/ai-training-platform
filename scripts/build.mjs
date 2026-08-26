#!/usr/bin/env node
/**
 * Build wrapper.
 *
 * WHY THIS EXISTS
 *
 * Next resolves the package registry by shelling out to
 * `<package manager> config get registry`, and it picks the package manager
 * from `process.env.npm_config_user_agent` (see next/dist/esm/lib/helpers/
 * get-pkg-manager.js - the user agent is checked BEFORE any lockfile).
 *
 * pnpm sets that variable to `pnpm/…`, so Next runs `pnpm config get registry`.
 * Our host does not put pnpm on PATH for child processes, so that command
 * fails with `command not found` and the whole build dies - even though the
 * only reason Next wanted the registry was to fetch a package that is already
 * installed.
 *
 * Worse, `getRegistry()` assigns a perfectly good default of
 * `https://registry.npmjs.org/` and then throws instead of falling back to it.
 *
 * Presenting npm in the user agent makes Next ask npm instead, and npm IS on
 * PATH everywhere we deploy. pnpm still performs the real install, and every
 * supply-chain control in pnpm-workspace.yaml stays in force - this changes
 * only which binary answers one question about a registry URL.
 *
 * Hostinger's control panel force-uppercases environment variable keys, so
 * `npm_config_user_agent` cannot be set there; it has to be set in-process.
 *
 * REMOVE THIS when the host ships a build image with glibc >= 2.29 (making the
 * native compiler work, so no registry lookup ever happens) or puts pnpm on
 * the PATH inherited by child processes. Hostinger support has acknowledged
 * both as platform-side fixes.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Resolve Next's entry point directly rather than relying on PATH or a shell,
// which keeps this identical on Windows, Linux and CI.
const nextBin = require.resolve("next/dist/bin/next");

const env = { ...process.env };
env.npm_config_user_agent = `npm/10.9.8 node/${process.version} ${process.platform} ${process.arch}`;

const result = spawnSync(process.execPath, [nextBin, "build", "--webpack"], {
  stdio: "inherit",
  env,
});

if (result.error) {
  console.error("Failed to start the Next.js build:", result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
