-- Desk alerts: a problem a person has to act on, emailed to the booking desk
-- until it goes away by itself.
--
-- One row per problem while it lasts. It is raised (and emailed) when the
-- problem first appears, emailed again once a day while it stays, and
-- resolved, silently, the run it disappears. If the same problem comes back
-- later it is a new row: the partial unique index allows one OPEN alert per
-- problem, never two.
--
-- Holds ids and timestamps only, never a name, email address or amount, so
-- nothing here is personal data. No foreign keys: the subject is a key such
-- as 'refund:<uuid>', so the retention purge can delete whatever it points
-- at without being blocked. Resolved alerts are deleted after a year by the
-- same purge, to keep the table small.

create table if not exists public.desk_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('refund_needs_attention')),
  subject_key text not null check (length(subject_key) between 1 and 200),
  first_raised_at timestamptz not null,
  -- Set only after an email actually went. Null while the first send keeps
  -- failing, so the next run tries again.
  last_sent_at timestamptz,
  sends integer not null default 0 check (sends >= 0),
  -- A run that is sending this alert holds it until then. The email service
  -- does not dedupe, so this claim is what stops two overlapping runs from
  -- both emailing the desk.
  claimed_until timestamptz,
  -- When a send was last tried, sent or not. A failed try waits half an hour.
  last_attempt_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists desk_alerts_one_open_per_subject
  on public.desk_alerts (kind, subject_key)
  where resolved_at is null;

alter table public.desk_alerts enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.desk_alerts from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.desk_alerts from authenticated;
  end if;
end;
$$;
