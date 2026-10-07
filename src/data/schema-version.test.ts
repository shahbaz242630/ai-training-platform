import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { QueryRunner } from "./db";
import { EXPECTED_SCHEMA_VERSION, readAppliedSchemaVersion, schemaStatus } from "./schema-version";

/**
 * A running instance knowing when its database is behind the code. Without
 * this, a missed migration shows up only as a query failing in front of a
 * customer.
 */

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
}, 120_000);

afterAll(async () => {
  await db?.close();
});

describe("EXPECTED_SCHEMA_VERSION", () => {
  it("is the newest migration in the repository", () => {
    const newest = readdirSync(join(process.cwd(), "supabase", "migrations"))
      .filter((name) => name.endsWith(".sql"))
      .toSorted()
      .at(-1);
    expect(newest?.slice(0, 14)).toBe(EXPECTED_SCHEMA_VERSION);
  });
});

describe("readAppliedSchemaVersion", () => {
  it("is null when the database has no migration ledger", async () => {
    expect(await readAppliedSchemaVersion(db as unknown as QueryRunner)).toBeNull();
  });

  it("is the newest version the ledger records", async () => {
    await db.exec(`create table public.schema_migrations (
      version text primary key, name text not null, checksum text not null,
      applied_at timestamptz not null default now())`);
    await db.exec(`insert into public.schema_migrations (version, name, checksum)
      values ('20260826190000', 'a', 'x'), ('20260928100000', 'b', 'y')`);
    expect(await readAppliedSchemaVersion(db as unknown as QueryRunner)).toBe("20260928100000");
  });
});

describe("schemaStatus", () => {
  it("is current when the database has the newest migration", () => {
    expect(schemaStatus(EXPECTED_SCHEMA_VERSION)).toEqual({
      expected: EXPECTED_SCHEMA_VERSION,
      applied: EXPECTED_SCHEMA_VERSION,
      current: true,
    });
  });

  it("is behind when a migration is missing, or nothing is recorded", () => {
    expect(schemaStatus("20260826190000").current).toBe(false);
    expect(schemaStatus(null).current).toBe(false);
  });
});
