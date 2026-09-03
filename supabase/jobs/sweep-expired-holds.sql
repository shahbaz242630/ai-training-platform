-- Schedule the expired-hold sweep.
--
-- NOT a migration, and deliberately not in supabase/migrations/. Two reasons:
--
--   1. It needs pg_cron and pg_net, which the in-process Postgres the
--      migration tests run against does not have. Putting it there would fail
--      every test for a reason unrelated to the schema.
--   2. It carries a deployment URL and reads a secret. Those differ per
--      environment, so this is run once per environment by hand rather than
--      applied blindly everywhere.
--
-- Run it in the Supabase SQL editor, once, per environment.
--
-- BEFORE RUNNING, create the two secrets in Vault (Dashboard -> Project
-- Settings -> Vault). They are read from there rather than written into this
-- file, because this repository is public and a cron secret in a committed
-- file is a published cron secret:
--
--   sweep_holds_url     https://<your-deployment>/api/cron/sweep-holds
--   sweep_holds_secret  the same value as CRON_SECRET in the app environment
--
-- If CRON_SECRET is not set on the application side, the route answers 500 and
-- sweeps nothing. That is on purpose: an unconfigured secret must break the
-- job loudly rather than leave an endpoint anyone can call.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: re-running this file re-creates the schedule rather than
-- stacking a second copy of the same job.
select cron.unschedule('sweep-expired-holds')
where exists (select 1 from cron.job where jobname = 'sweep-expired-holds');

select cron.schedule(
  'sweep-expired-holds',
  -- Every five minutes, so a slot is back on sale within five minutes of its
  -- hold falling due. Tighter buys nothing: availability
  -- already ignores an expired hold the moment it expires, whether or not this
  -- has run.
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets
                 where name = 'sweep_holds_url'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets
                                      where name = 'sweep_holds_secret')
    ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);

-- Check it afterwards:
--   select jobname, schedule, active from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 10;
--
-- cron.job_run_details records whether the HTTP call was MADE, not whether it
-- succeeded. For the response, read net._http_response.
