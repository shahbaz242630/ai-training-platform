#!/usr/bin/env node
/**
 * `pnpm graph:smoke` - prove the Microsoft Graph integration against the
 * real tenant, once the client secret exists.
 *
 * Reads MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET and MS_CALENDAR_USER_ID
 * from `.env.local`, and optionally GRAPH_SMOKE_ATTENDEE for who receives
 * the test invitation (defaults to the booking mailbox itself). Then runs
 * the one live test, which holds, confirms, cancels and deletes a single
 * event and reports the join link it was issued.
 *
 * The test file is skipped in every other run, so this wrapper is the only
 * thing that sets the flag.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
// Vitest 4 no longer exports "./vitest.mjs", so find the package folder through
// its package.json (which it does export) and start the CLI file from there.
const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");

const result = spawnSync(process.execPath, [vitest, "run", "scripts/graph-smoke.test.mjs"], {
  stdio: "inherit",
  env: { ...process.env, GRAPH_SMOKE: "1" },
});

process.exit(result.status ?? 1);
