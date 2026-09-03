import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  LEDGER_TABLE,
  MigrationError,
  check,
  checksum,
  listMigrations,
  markApplied,
  migrate,
  plan,
  readLedger,
} from "./migrations.mjs";

/**
 * These run against a real in-process Postgres, the same one the migration
 * files themselves are tested against. A migration runner proven only with a
 * fake database has proven nothing about transactions.
 */

const REAL_MIGRATIONS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "supabase",
  "migrations",
);

let pg;
let db;
let dir;

/*
  One Postgres for the whole file, with the schema wiped between tests.
  Starting an instance per test is simple but slow enough that, with the rest
  of the suite running alongside, the first one overran the hook timeout in
  the full gate while passing on its own. Dropping and recreating the schema
  gives each test the same clean slate in a fraction of the time.
*/
beforeAll(async () => {
  pg = await PGlite.create();
  // The runner's contract: one parameterised statement, or a whole file.
  db = { query: (text, params) => pg.query(text, params), run: pg.exec.bind(pg) };
}, 120_000);

afterAll(async () => {
  await pg?.close();
});

beforeEach(async () => {
  await db.run("drop schema public cascade; create schema public;");
  dir = mkdtempSync(join(tmpdir(), "migrations-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const write = (file, sql) => writeFileSync(join(dir, file), sql);

async function tableExists(name) {
  const result = await db.query("select to_regclass($1) as t", [`public.${name}`]);
  return result.rows[0].t != null;
}

describe("listMigrations", () => {
  it("lists the real migrations in version order, and there are some", () => {
    const migrations = listMigrations(REAL_MIGRATIONS);
    expect(migrations.length).toBeGreaterThan(0);
    const versions = migrations.map((m) => m.version);
    expect(versions).toEqual(versions.toSorted());
    expect(migrations[0]).toMatchObject({ version: "20260826190000", name: "booking_core" });
  });

  it("refuses a file that does not follow the naming rule, rather than skipping it", () => {
    write("20260901000000_fine.sql", "select 1;");
    write("hotfix.sql", "select 1;");
    expect(() => listMigrations(dir)).toThrow(MigrationError);
    expect(() => listMigrations(dir)).toThrow(/hotfix\.sql/);
  });

  it("checksums the content as read", () => {
    write("20260901000000_one.sql", "create table one (id int);");
    const [one] = listMigrations(dir);
    expect(one.checksum).toBe(checksum("create table one (id int);"));
  });
});

describe("plan", () => {
  const m = (version, content) => ({
    file: `${version}_x.sql`,
    version,
    name: "x",
    content,
    checksum: checksum(content),
  });

  it("classifies pending, applied and drifted", () => {
    const one = m("20260901000000", "a");
    const two = m("20260902000000", "b");
    const three = m("20260903000000", "c");
    const ledger = new Map([
      [one.version, { name: "x", checksum: one.checksum }],
      [two.version, { name: "x", checksum: checksum("b-edited") }],
      ["20260801000000", { name: "gone", checksum: "whatever" }],
    ]);

    const result = plan([one, two, three], ledger);

    expect(result.applied.map((x) => x.version)).toEqual([one.version]);
    expect(result.pending.map((x) => x.version)).toEqual([three.version]);
    expect(result.drifted.map((x) => [x.file, x.reason])).toEqual([
      [two.file, "edited after it was applied"],
      ["20260801000000_gone.sql", "recorded as applied, but no such file exists"],
    ]);
  });

  it("treats an empty ledger as everything pending", () => {
    const one = m("20260901000000", "a");
    expect(plan([one], new Map())).toEqual({ pending: [one], applied: [], drifted: [] });
  });
});

describe("check", () => {
  it("is read-only: reports everything pending on a fresh database and creates no ledger", async () => {
    write("20260901000000_one.sql", "create table one (id int);");

    const result = await check(db, dir);

    expect(result.ledgerExists).toBe(false);
    expect(result.pending.map((x) => x.file)).toEqual(["20260901000000_one.sql"]);
    expect(await tableExists("schema_migrations")).toBe(false);
    expect(await tableExists("one")).toBe(false);
  });
});

describe("migrate", () => {
  it("applies the real migrations, records each one, and is a no-op the second time", async () => {
    const applied = await migrate(db, REAL_MIGRATIONS);

    const files = listMigrations(REAL_MIGRATIONS).map((x) => x.file);
    expect(applied.map((x) => x.file)).toEqual(files);
    expect(await tableExists("slot_holds")).toBe(true);
    expect(await tableExists("audit_events")).toBe(true);

    const ledger = await readLedger(db);
    expect([...ledger.keys()]).toEqual(listMigrations(REAL_MIGRATIONS).map((x) => x.version));

    expect(await migrate(db, REAL_MIGRATIONS)).toEqual([]);
    expect((await readLedger(db)).size).toBe(files.length);

    const status = await check(db, REAL_MIGRATIONS);
    expect(status.pending).toEqual([]);
    expect(status.drifted).toEqual([]);
  });

  it("protects the ledger like every other table: row level security is on", async () => {
    await migrate(db, dir);
    const result = await db.query("select relrowsecurity from pg_class where oid = $1::regclass", [
      LEDGER_TABLE,
    ]);
    expect(result.rows[0].relrowsecurity).toBe(true);
  });

  it("applies in version order and logs each file", async () => {
    write("20260902000000_two.sql", "insert into one values (2);");
    write("20260901000000_one.sql", "create table one (id int); insert into one values (1);");
    const log = [];

    await migrate(db, dir, { log: (line) => log.push(line) });

    expect(log).toEqual(["applied 20260901000000_one.sql", "applied 20260902000000_two.sql"]);
    const rows = await db.query("select id from one order by id");
    expect(rows.rows.map((r) => r.id)).toEqual([1, 2]);
  });

  it("rolls a failed migration back completely and does not record it", async () => {
    write("20260901000000_good.sql", "create table good (id int);");
    write(
      "20260902000000_bad.sql",
      "create table half_done (id int); insert into half_done values ('not a number');",
    );
    write("20260903000000_never.sql", "create table never (id int);");

    await expect(migrate(db, dir)).rejects.toThrow(MigrationError);
    await expect(migrate(db, dir)).rejects.toThrow(
      /20260902000000_bad\.sql failed and was rolled back/,
    );

    expect(await tableExists("good")).toBe(true);
    expect(await tableExists("half_done")).toBe(false);
    expect(await tableExists("never")).toBe(false);
    expect([...(await readLedger(db)).keys()]).toEqual(["20260901000000"]);
  });

  it("refuses to run when an applied file has been edited, and says which", async () => {
    write("20260901000000_one.sql", "create table one (id int);");
    await migrate(db, dir);

    write("20260901000000_one.sql", "create table one (id int, extra text);");
    write("20260902000000_two.sql", "create table two (id int);");

    const status = await check(db, dir);
    expect(status.drifted.map((x) => x.file)).toEqual(["20260901000000_one.sql"]);
    expect(status.pending.map((x) => x.file)).toEqual(["20260902000000_two.sql"]);

    await expect(migrate(db, dir)).rejects.toThrow(
      /20260901000000_one\.sql: edited after it was applied/,
    );
    expect(await tableExists("two")).toBe(false);
  });

  it("refuses to run when the ledger names a file that no longer exists", async () => {
    write("20260901000000_one.sql", "create table one (id int);");
    await migrate(db, dir);
    rmSync(join(dir, "20260901000000_one.sql"));

    await expect(migrate(db, dir)).rejects.toThrow(/recorded as applied, but no such file exists/);
  });
});

describe("markApplied", () => {
  it("records a migration without running it, so a hand-applied schema can join the ledger", async () => {
    write("20260901000000_by_hand.sql", "create table by_hand (id int);");
    const [migration] = listMigrations(dir);

    await markApplied(db, migration);

    expect(await tableExists("by_hand")).toBe(false);
    expect((await readLedger(db)).get("20260901000000")).toMatchObject({
      name: "by_hand",
      checksum: migration.checksum,
    });
    expect(await migrate(db, dir)).toEqual([]);
  });

  it("is idempotent", async () => {
    write("20260901000000_by_hand.sql", "create table by_hand (id int);");
    const [migration] = listMigrations(dir);
    await markApplied(db, migration);
    await markApplied(db, migration);
    expect((await readLedger(db)).size).toBe(1);
  });
});
