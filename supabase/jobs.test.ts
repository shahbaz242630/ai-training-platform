import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

/**
 * The scheduled-job file is run by hand in the Supabase SQL editor, once per
 * environment, so nothing ever executed it before a real environment did. The
 * send job's body was quoted with a single `$` (not a dollar quote), so the
 * file failed on its second job and no customer email would ever have been
 * delivered, with nothing saying why.
 *
 * Here the file runs for real against an in-process Postgres. pg_cron, pg_net
 * and Vault are not available there, so each is replaced by a stand-in that
 * records what it was asked: `cron.schedule` keeps the job, `net.http_post`
 * keeps the request. Every scheduled command is then executed, which proves it
 * parses AND that it calls the right address with the cron password.
 */

const JOBS_FILE = join(dirname(fileURLToPath(import.meta.url)), "jobs", "sweep-expired-holds.sql");

const STAND_INS = `
  create schema cron;
  create table cron.job (jobname text primary key, schedule text, command text, active boolean default true);
  create function cron.schedule(name text, schedule text, command text) returns bigint
    language sql as $f$
      insert into cron.job (jobname, schedule, command) values (name, schedule, command)
        on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command;
      select 1::bigint;
    $f$;
  create function cron.unschedule(name text) returns boolean
    language sql as $f$ delete from cron.job where jobname = name; select true; $f$;

  create schema vault;
  create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
  insert into vault.decrypted_secrets values
    ('sweep_holds_url', 'https://staging.example/api/cron/sweep-holds'),
    ('send_communications_url', 'https://staging.example/api/cron/send-communications'),
    ('sweep_holds_secret', 'x-cron-password');

  create schema net;
  create table net.requests (url text, headers jsonb, body jsonb, timeout_milliseconds int);
  create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int)
    returns bigint language sql as $f$
      insert into net.requests values (url, headers, body, timeout_milliseconds);
      select 1::bigint;
    $f$;
`;

/** The file without its `create extension` lines, which only a real Supabase project can run. */
function jobsSql(): string {
  return readFileSync(JOBS_FILE, "utf8")
    .split("\n")
    .filter((line) => !/^\s*create extension/i.test(line))
    .join("\n");
}

describe("scheduled jobs file", () => {
  let db: PGlite;

  // Same allowance as every other in-process Postgres: under a full parallel run, booting one is slow.
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(STAND_INS);
  }, 120_000);

  afterAll(async () => {
    await db.close();
  });

  it("runs to the end and schedules both jobs every five minutes", async () => {
    await db.exec(jobsSql());
    const jobs = await db.query<{ jobname: string; schedule: string }>(
      "select jobname, schedule from cron.job order by jobname",
    );
    expect(jobs.rows).toEqual([
      { jobname: "send-communications", schedule: "*/5 * * * *" },
      { jobname: "sweep-expired-holds", schedule: "*/5 * * * *" },
    ]);
  });

  it("can be run again without stacking a second copy of either job", async () => {
    await db.exec(jobsSql());
    const count = await db.query<{ n: number }>("select count(*)::int as n from cron.job");
    expect(count.rows[0]?.n).toBe(2);
  });

  it("each job posts to its own address with the cron password", async () => {
    const jobs = await db.query<{ jobname: string; command: string }>(
      "select jobname, command from cron.job order by jobname",
    );
    const sent: Record<string, { url: string; authorization: string }> = {};
    for (const job of jobs.rows) {
      await db.exec("delete from net.requests");
      await db.exec(job.command);
      const request = await db.query<{ url: string; authorization: string }>(
        "select url, headers->>'Authorization' as authorization from net.requests",
      );
      expect(request.rows).toHaveLength(1);
      sent[job.jobname] = request.rows[0]!;
    }
    expect(sent).toEqual({
      "send-communications": {
        url: "https://staging.example/api/cron/send-communications",
        authorization: "Bearer x-cron-password",
      },
      "sweep-expired-holds": {
        url: "https://staging.example/api/cron/sweep-holds",
        authorization: "Bearer x-cron-password",
      },
    });
  });
});
