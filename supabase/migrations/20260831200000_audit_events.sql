-- The audit trail, persisted.
--
-- SECURITY.md claimed this control existed. It did not: audit events were
-- written through the application logger to the host's stdout, which is not
-- evidence of anything - it rotates, it is not queryable, and on a managed
-- host nobody owns it. For a system that takes money and blocks a diary, the
-- record of what happened to somebody's payment cannot live there.
--
-- Deliberately separate from application logging. Logs explain what the system
-- did; this is evidence of what happened to a person's money and booking.

create table if not exists public.audit_events (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  -- Who did it, split so the kind can be filtered without parsing text.
  actor_kind text not null check (actor_kind in ('customer', 'admin', 'system', 'provider')),
  actor_id text,
  -- What was acted upon, e.g. `order:01H...`. Indexed, because the first
  -- question anybody asks is "what happened to this order".
  subject text not null,
  -- Never card data, never a token. The redacting logger cannot help here, so
  -- callers pass only what they would be content to see in a subject access
  -- request.
  metadata jsonb,
  -- When it happened, which is not the same as when we managed to write it.
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now()
);

create index if not exists audit_events_subject_idx
  on public.audit_events (subject, occurred_at desc);
create index if not exists audit_events_action_idx
  on public.audit_events (action, occurred_at desc);

-- APPEND-ONLY, enforced rather than intended.
--
-- `audit.ts` has always described this trail as append-only. A comment does
-- not make it so: an audit row that can be edited or deleted is not evidence,
-- because the first thing anybody covering a mistake would do is change it.
-- The trigger makes the database refuse, so it holds even for a connection
-- with full table rights.
create or replace function public.audit_events_are_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_events is append-only; % is not permitted', tg_op;
end;
$$;

drop trigger if exists audit_events_no_update on public.audit_events;
create trigger audit_events_no_update
  before update or delete on public.audit_events
  for each row execute function public.audit_events_are_append_only();

alter table public.audit_events enable row level security;

-- Guarded on role existence, matching the first migration. The Supabase roles
-- do not exist in the in-process Postgres the migration tests run against, and
-- an unguarded revoke there fails the whole file for a reason unrelated to the
-- schema being correct.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.audit_events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.audit_events from authenticated;
  end if;
end
$$;
