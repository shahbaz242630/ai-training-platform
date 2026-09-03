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

const require = createRequire(import.meta.url);
const vitest = require.resolve("vitest/vitest.mjs");

const result = spawnSync(process.execPath, [vitest, "run", "scripts/graph-smoke.test.mjs"], {
  stdio: "inherit",
  env: { ...process.env, GRAPH_SMOKE: "1" },
});

process.exit(result.status ?? 1);
