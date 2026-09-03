/**
 * Applying database migrations, and knowing whether they have been applied.
 *
 * WHY THIS EXISTS. The schema was first applied to the real database by hand,
 * on the day the project was created. Five more migrations then merged to
 * `main` - one of them the fix for two customers being able to pay for the
 * same time slot - and none of them reached that database. Nothing noticed:
 * `pnpm verify` has no database, CI has no database, and the host builds
 * whatever is on `main` without asking whether the schema underneath it still
 * matches. The gap was found three days later, by reading the catalogue.
 *
 * So this module does two things. It applies pending migrations in filename
 * order, each inside its own transaction so a failure leaves nothing
 * half-applied. And it records each one in a ledger table, so the question
 * "is this database current?" has an answer a script can check and fail on.
 *
 * The ledger stores a checksum of every file as it was applied. A migration
 * that is edited after it has run is reported as drift rather than ignored: a
 * file that no longer says what the database actually did is a false record,
 * and the honest response is to refuse and make somebody look.
 *
 * Everything here takes a `db` with `query(text, params)` for a single
 * parameterised statement and `run(sql)` for a whole migration file. That is
 * the shape of both the `pg` client the CLI uses and the in-process Postgres
 * the tests use, so the same code is exercised in both. The only input `run`
 * ever receives is a migration file read from this repository.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export const LEDGER_TABLE = "public.schema_migrations";

/**
 * `YYYYMMDDHHMMSS_short_name.sql`. The timestamp orders migrations and is the
 * version recorded in the ledger; the name is for humans reading it.
 */
const FILE_NAME = /^(\d{14})_([a-z0-9_]+)\.sql$/;

export class MigrationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "MigrationError";
  }
}

export function checksum(content) {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Every migration in the folder, in the order it applies.
 *
 * A file that does not follow the naming rule is an error, not something to
 * skip. A migration silently left out because of its name is exactly the
 * failure this module exists to end.
 */
export function listMigrations(dir) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .toSorted();

  return files.map((file) => {
    const match = FILE_NAME.exec(file);
    if (!match) {
      throw new MigrationError(
        `migration file name not recognised: ${file} (expected YYYYMMDDHHMMSS_name.sql)`,
      );
    }
    const content = readFileSync(join(dir, file), "utf8");
    return { file, version: match[1], name: match[2], content, checksum: checksum(content) };
  });
}

export async function ledgerExists(db) {
  const result = await db.query("select to_regclass($1) as ledger", [LEDGER_TABLE]);
  return result.rows[0]?.ledger != null;
}

/**
 * The ledger is server-side bookkeeping. It gets the same treatment as every
 * other table: row level security on, and nothing granted to the public
 * roles. The revokes are guarded on the roles existing, because the
 * in-process Postgres the tests run against does not have them.
 */
export async function ensureLedger(db) {
  await db.run(`
    create table if not exists ${LEDGER_TABLE} (
      version text primary key,
      name text not null,
      checksum text not null,
      applied_at timestamptz not null default now()
    );
    alter table ${LEDGER_TABLE} enable row level security;
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on ${LEDGER_TABLE} from anon;
      end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke all on ${LEDGER_TABLE} from authenticated;
      end if;
    end
    $$;
  `);
}

/** What the database says has been applied, keyed by version. Empty when there is no ledger yet. */
export async function readLedger(db) {
  if (!(await ledgerExists(db))) return new Map();
  const result = await db.query(
    `select version, name, checksum from ${LEDGER_TABLE} order by version`,
  );
  return new Map(result.rows.map((row) => [row.version, row]));
}

/**
 * Compare the files on disk with the ledger. Pure, so it can be reasoned
 * about without a database.
 *
 * Drift is reported in both directions: a file whose content no longer
 * matches what was applied, and a ledger row for a file that no longer
 * exists. Neither is safe to build on top of.
 */
export function plan(migrations, ledger) {
  const pending = [];
  const applied = [];
  const drifted = [];

  for (const migration of migrations) {
    const row = ledger.get(migration.version);
    if (!row) pending.push(migration);
    else if (row.checksum !== migration.checksum) {
      drifted.push({ ...migration, reason: "edited after it was applied" });
    } else applied.push(migration);
  }

  const onDisk = new Set(migrations.map((migration) => migration.version));
  for (const [version, row] of ledger) {
    if (!onDisk.has(version)) {
      drifted.push({
        version,
        name: row.name,
        file: `${version}_${row.name}.sql`,
        reason: "recorded as applied, but no such file exists",
      });
    }
  }

  return { pending, applied, drifted };
}

export function describeDrift(drifted) {
  return drifted.map((entry) => `  ${entry.file}: ${entry.reason}`).join("\n");
}

/**
 * One migration, one transaction. The ledger row is written inside the same
 * transaction as the schema change, so the database can never say a
 * migration was applied when it was not, or the reverse.
 */
export async function applyMigration(db, migration) {
  await db.run("begin");
  try {
    await db.run(migration.content);
    await db.query(`insert into ${LEDGER_TABLE} (version, name, checksum) values ($1, $2, $3)`, [
      migration.version,
      migration.name,
      migration.checksum,
    ]);
    await db.run("commit");
  } catch (error) {
    await db.run("rollback");
    throw new MigrationError(`${migration.file} failed and was rolled back: ${error.message}`, {
      cause: error,
    });
  }
}

/**
 * Record a migration as applied WITHOUT running it.
 *
 * For exactly one situation: a database whose schema was applied by hand
 * before the ledger existed, where re-running the file would fail on objects
 * that are already there. It is never a way to skip a migration - a skipped
 * migration is a database that lies about itself.
 */
export async function markApplied(db, migration) {
  await ensureLedger(db);
  await db.query(
    `insert into ${LEDGER_TABLE} (version, name, checksum) values ($1, $2, $3)
     on conflict (version) do nothing`,
    [migration.version, migration.name, migration.checksum],
  );
}

/**
 * Read-only. Creates nothing, so it is safe to run against any database at
 * any time - including one where the ledger has never been created, which it
 * reports as "everything pending" rather than quietly making a table.
 */
export async function check(db, dir) {
  const migrations = listMigrations(dir);
  const hasLedger = await ledgerExists(db);
  const ledger = await readLedger(db);
  return { ledgerExists: hasLedger, ...plan(migrations, ledger) };
}

/**
 * Apply everything pending, in order, stopping at the first failure.
 *
 * Refuses outright when there is drift. Applying a new migration on top of a
 * database whose history is already wrong compounds the problem, and the
 * person running this needs to see the drift, not have it scrolled past.
 */
export async function migrate(db, dir, { log = () => {} } = {}) {
  const migrations = listMigrations(dir);
  await ensureLedger(db);
  const { pending, drifted } = plan(migrations, await readLedger(db));

  if (drifted.length > 0) {
    throw new MigrationError(
      `refusing to migrate: the ledger and the files disagree\n${describeDrift(drifted)}`,
    );
  }

  for (const migration of pending) {
    await applyMigration(db, migration);
    log(`applied ${migration.file}`);
  }
  return pending;
}
