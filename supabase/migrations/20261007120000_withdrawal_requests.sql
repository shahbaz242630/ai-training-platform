-- Withdrawals: the customer's notice that they withdraw from the contract.
--
-- UK and EU consumers may cancel a booking within 14 days, and the trader must
-- offer an online "withdraw from contract here" function and acknowledge each
-- notice on a durable medium straight away. This table is the record of each
-- notice: who gave it, for which booking, the words of the statement, when it
-- was received, and the refund that was due at that moment.
--
-- One per booking, so a second press of "Confirm withdrawal" (a double click,
-- a retried request) is the same notice, not a second one. Never edited: it is
-- the evidence a dispute is answered with, the same rule as booking_consents.

create table if not exists public.withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.bookings (id) on delete restrict,
  -- The name as the customer typed it on the form.
  full_name text not null check (length(trim(full_name)) between 1 and 200),
  -- The address the booking was made with, lower-cased, as matched.
  email text not null check (email = lower(email) and length(email) <= 320),
  -- The statement as the page showed it and the customer confirmed it.
  statement text not null check (length(statement) between 1 and 2000),
  refund_due_fils bigint not null check (refund_due_fils >= 0),
  received_at timestamptz not null,
  ip_address text,
  user_agent text check (user_agent is null or length(user_agent) <= 500),
  created_at timestamptz not null default now()
);

create or replace function public.withdrawal_requests_are_not_edited()
returns trigger
language plpgsql
as $$
begin
  raise exception 'withdrawal_requests cannot be edited; % is not permitted', tg_op;
end;
$$;

drop trigger if exists withdrawal_requests_no_update on public.withdrawal_requests;
create trigger withdrawal_requests_no_update
  before update on public.withdrawal_requests
  for each row execute function public.withdrawal_requests_are_not_edited();

alter table public.withdrawal_requests enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.withdrawal_requests from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.withdrawal_requests from authenticated;
  end if;
end;
$$;
