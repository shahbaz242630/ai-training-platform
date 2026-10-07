import type { QueryRunner } from "./db";

/**
 * The newest migration this code needs. A test holds it equal to the newest
 * file in supabase/migrations, so adding a migration without updating it
 * fails the build.
 *
 * The sweep compares it with the ledger every run and raises an alarm while
 * the database is behind: a migration that was never applied would otherwise
 * show up only as a query failing in front of a customer.
 */
export const EXPECTED_SCHEMA_VERSION = "20261007120000";

/** The newest version the migration ledger records; null when there is no ledger. */
export async function readAppliedSchemaVersion(runner: QueryRunner): Promise<string | null> {
  const ledger = await runner.query<{ ledger: string | null }>(
    `select to_regclass('public.schema_migrations')::text as ledger`,
  );
  if (!ledger.rows[0]?.ledger) return null;
  const result = await runner.query<{ version: string | null }>(
    `select max(version) as version from public.schema_migrations`,
  );
  return result.rows[0]?.version ?? null;
}

export interface SchemaStatus {
  readonly expected: string;
  readonly applied: string | null;
  readonly current: boolean;
}

export function schemaStatus(applied: string | null): SchemaStatus {
  return {
    expected: EXPECTED_SCHEMA_VERSION,
    applied,
    current: applied !== null && applied >= EXPECTED_SCHEMA_VERSION,
  };
}
