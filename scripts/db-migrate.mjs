#!/usr/bin/env node
/**
 * Bring the database up to date with `supabase/migrations`, or say whether it is.
 *
 *   pnpm db:check                        read-only; exits 1 if anything is
 *                                        pending or the history has drifted
 *   pnpm db:migrate                      apply every pending migration, in order
 *   pnpm db:migrate --mark-applied FILE  record FILE as applied without running
 *                                        it - for a schema that was applied by
 *                                        hand before the ledger existed, never
 *                                        for skipping a migration
 *
 * Reads DATABASE_URL and DATABASE_CA_CERT. `.env.local` is loaded by the
 * package script, so locally this needs nothing else. Run it once per
 * environment; each environment has its own database and its own ledger.
 *
 * The connection string is never printed.
 */
import pg from "pg";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connectionOptions } from "./db-connection.mjs";
import { check, listMigrations, markApplied, migrate, MigrationError } from "./migrations.mjs";

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "migrations",
);

const say = (line) => console.log(line);
const warn = (line) => console.error(`warning: ${line}`);

function usage(message) {
  console.error(`error: ${message}`);
  console.error("usage: db-migrate.mjs [--check] [--mark-applied FILE]");
  process.exit(2);
}

function report(result) {
  if (!result.ledgerExists)
    say("no migration ledger exists yet - every migration counts as pending");
  say(`applied: ${result.applied.length}`);
  for (const migration of result.pending) say(`pending: ${migration.file}`);
  for (const entry of result.drifted) say(`DRIFT:   ${entry.file} - ${entry.reason}`);
  if (result.pending.length === 0 && result.drifted.length === 0) say("database is current");
}

async function main(argv) {
  const args = argv.slice(2);
  const checkOnly = args.includes("--check");
  const markIndex = args.indexOf("--mark-applied");
  const markFile = markIndex >= 0 ? args[markIndex + 1] : undefined;
  if (markIndex >= 0 && (!markFile || markFile.startsWith("--")))
    usage("--mark-applied needs a file name");
  if (checkOnly && markFile) usage("--check and --mark-applied cannot be combined");

  const client = new pg.Client(connectionOptions(process.env, warn));
  await client.connect();
  // A query with no parameters goes over the simple protocol, which is what
  // lets one call run a whole multi-statement migration file.
  const db = {
    query: (text, params) => client.query(text, params),
    run: async (sql) => {
      await client.query(sql);
    },
  };

  try {
    if (checkOnly) {
      const result = await check(db, MIGRATIONS_DIR);
      report(result);
      return result.pending.length === 0 && result.drifted.length === 0 ? 0 : 1;
    }

    if (markFile) {
      const migration = listMigrations(MIGRATIONS_DIR).find((entry) => entry.file === markFile);
      if (!migration) usage(`no migration named ${markFile}`);
      await markApplied(db, migration);
      say(`recorded ${migration.file} as applied (not run)`);
      return 0;
    }

    const applied = await migrate(db, MIGRATIONS_DIR, { log: say });
    say(
      applied.length === 0
        ? "nothing to apply - database is current"
        : `applied ${applied.length} migration(s)`,
    );
    return 0;
  } finally {
    await client.end();
  }
}

main(process.argv)
  .then((code) => process.exit(code))
  .catch((error) => {
    // A failed migration has already been rolled back; say what failed and
    // stop. Never dump the error object, which can carry the connection config.
    const message =
      error instanceof MigrationError ? error.message : `${error.name}: ${error.message}`;
    console.error(`error: ${message}`);
    process.exit(1);
  });
