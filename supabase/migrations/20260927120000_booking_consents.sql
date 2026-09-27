-- What the customer agreed to, exactly as it was shown, for each order.
--
-- A tick in a browser proves nothing later unless we kept what the box said,
-- which version of the terms it pointed at, and when and from where it was
-- ticked. Card disputes ("I was never told there was no refund") and a UK or
-- EU consumer's 14-day cancellation right both turn on this record: without
-- the express request and acknowledgement, a consumer who cancels after the
-- session may owe nothing at all. Stripe's own checkout tick records only
-- "accepted", so this table is the evidence.
--
-- One row per order. Written in the same transaction as the pending order, so
-- an order can never exist without the agreement it was placed under.
-- Corrections are never made in place: UPDATE is refused, so the record
-- cannot be edited after the fact. DELETE stays possible for the retention
-- period's end (seven years after the tax year).

create table if not exists public.booking_consents (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders (id),
  -- The terms version the page was built with, e.g. 2026-09-27.
  terms_version text not null check (length(terms_version) between 1 and 40),
  -- The bold key-terms box, one line per item, as shown.
  key_terms text not null,
  -- The always-required tickbox, as shown.
  agreement_text text not null,
  -- The 14-day express request and acknowledgement, as shown; null when the
  -- session was outside the cancellation period and the box was not shown.
  express_request_text text,
  -- True only when the session starts inside the 14-day cancellation period,
  -- decided on the server from the slot, never from the browser.
  within_cancellation_period boolean not null,
  express_request boolean not null,
  -- SHA-256 of the texts above, joined, so a copy can be proven unaltered.
  text_sha256 text not null check (text_sha256 ~ '^[0-9a-f]{64}$'),
  accepted_at timestamptz not null,
  ip_address text,
  user_agent text check (user_agent is null or length(user_agent) <= 500),
  created_at timestamptz not null default now(),
  -- The box was shown whenever it was needed, and ticked.
  constraint booking_consents_express_when_needed
    check (not within_cancellation_period or (express_request and express_request_text is not null))
);

create or replace function public.booking_consents_are_not_edited()
returns trigger
language plpgsql
as $$
begin
  raise exception 'booking_consents cannot be edited; % is not permitted', tg_op;
end;
$$;

drop trigger if exists booking_consents_no_update on public.booking_consents;
create trigger booking_consents_no_update
  before update on public.booking_consents
  for each row execute function public.booking_consents_are_not_edited();

alter table public.booking_consents enable row level security;

-- Guarded on role existence: the Supabase roles do not exist in the
-- in-process Postgres the migration tests run against.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.booking_consents from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.booking_consents from authenticated;
  end if;
end;
$$;
