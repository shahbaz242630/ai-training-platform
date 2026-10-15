-- Refunds: money going back to a customer, whoever started it.
--
-- Two kinds of row. A WITHDRAWAL row is written in the same transaction as a
-- UK or EU customer's withdrawal notice: the refund the law says we owe, in
-- full, issued by the five-minute sweep. A PROCESSOR row is a refund somebody
-- made in the Stripe dashboard; it is written when Stripe tells us about it,
-- so the order's payment status never says "paid" for money that went back.
--
-- Mutable on purpose: a refund moves from due to issued to succeeded (or
-- failed), and that movement is the point of the table. The history of each
-- move is in audit_events.
--
-- Kept with its order for as long as the order is kept. It is the answer to a
-- customer who is refunded and then also disputes the charge with their bank.

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  withdrawal_request_id uuid unique references public.withdrawal_requests (id) on delete restrict,
  origin text not null check (origin in ('withdrawal', 'processor')),
  amount_fils bigint not null check (amount_fils > 0),
  currency text not null,
  -- due: owed, not yet asked for. issuing: claimed by a sweep run, the request
  -- may be in flight. pending/succeeded/failed/canceled: what Stripe says.
  -- superseded: the order was already refunded another way, so nothing is sent.
  status text not null check (
    status in ('due', 'issuing', 'pending', 'succeeded', 'failed', 'canceled', 'superseded')
  ),
  provider_refund_id text unique,
  attempts integer not null default 0 check (attempts >= 0),
  -- Which idempotency key the next request uses. Moves on only after Stripe
  -- clearly refused a request, so a request that may have gone through is
  -- always repeated with the key that made it.
  key_seq integer not null default 0 check (key_seq >= 0),
  lease_until timestamptz,
  next_attempt_at timestamptz,
  -- When the current key was first sent. Stripe keeps a key's answer for 24
  -- hours; repeating an old key after that could make a second refund, so a
  -- refund still unclear that late is left for a person instead.
  key_first_used_at timestamptz,
  -- When the status last actually changed, kept by the trigger below. The
  -- pending alarm counts from here: a refund read again and found unchanged
  -- keeps its age.
  status_changed_at timestamptz not null default now(),
  -- When the processor was last asked about a pending refund, so it is asked
  -- about once an hour and not on every run.
  checked_at timestamptz,
  -- An error code from the processor, never its message.
  last_error text check (last_error is null or length(last_error) <= 100),
  -- When the newest processor event applied to this row was created, so an
  -- event that arrives late cannot move the row backwards.
  last_event_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (origin <> 'withdrawal' or withdrawal_request_id is not null)
);

create index if not exists refunds_order_idx on public.refunds (order_id);
create index if not exists refunds_open_idx on public.refunds (status, next_attempt_at)
  where status in ('due', 'issuing', 'pending');

-- status_changed_at moves only when the status does, stamped with the time
-- the writer gives (updated_at on a change, created_at on insert), so it
-- cannot be forgotten by one code path and kept by another.
create or replace function public.refunds_stamp_status_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.status_changed_at := new.created_at;
  elsif new.status is distinct from old.status then
    new.status_changed_at := new.updated_at;
  else
    new.status_changed_at := old.status_changed_at;
  end if;
  return new;
end;
$$;

drop trigger if exists refunds_status_changed_at on public.refunds;
create trigger refunds_status_changed_at
  before insert or update on public.refunds
  for each row execute function public.refunds_stamp_status_change();

alter table public.refunds enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.refunds from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.refunds from authenticated;
  end if;
end;
$$;
