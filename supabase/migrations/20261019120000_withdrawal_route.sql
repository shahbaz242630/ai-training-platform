-- Withdrawals: who decides the refund, and on what fact.
--
-- The withdrawal form's tick ("I am a UK or EU consumer") is the customer's
-- word, and until now it alone refunded the full price automatically. From
-- here a notice records the country the card was issued in, as the payment
-- processor reported it when the notice arrived, and the route that fact
-- chose: 'automatic' (a UK or EU card: the booking is cancelled and the refund
-- issued as before) or 'desk' (any other card, or none could be read: the
-- booking stays in place and a person decides within the 14 days).
--
-- Both are facts of the moment the notice was received, so they are written
-- with it and, like the rest of the row, never edited. Notices kept before
-- this migration were all refunded automatically, which the default records.

alter table public.withdrawal_requests
  add column if not exists route text not null default 'automatic'
    check (route in ('automatic', 'desk'));

alter table public.withdrawal_requests
  add column if not exists card_country text
    check (card_country is null or card_country ~ '^[A-Z]{2}$');

-- Desk alerts: a fourth kind, a withdrawal waiting for a person's decision.
-- Only the list of kinds changes, the house way, so running this twice
-- changes nothing.

alter table public.desk_alerts
  drop constraint if exists desk_alerts_kind_check;

alter table public.desk_alerts
  add constraint desk_alerts_kind_check
  check (kind in ('refund_needs_attention', 'calendar_event_changed', 'paid_booking_needs_time',
                  'withdrawal_needs_decision'));

-- The desk's decision to decline a withdrawal it decides: the booking stands
-- and nothing is refunded. Approving needs no row, because it is a full refund
-- in the payment dashboard and the refund itself is the record. One per
-- notice, kept as evidence and never edited, like the notice itself.

create table if not exists public.withdrawal_decisions (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null unique references public.withdrawal_requests (booking_id) on delete restrict,
  decision text not null check (decision in ('declined')),
  decided_at timestamptz not null,
  created_at timestamptz not null default now()
);

drop trigger if exists withdrawal_decisions_no_update on public.withdrawal_decisions;
create trigger withdrawal_decisions_no_update
  before update on public.withdrawal_decisions
  for each row execute function public.withdrawal_requests_are_not_edited();

alter table public.withdrawal_decisions enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.withdrawal_decisions from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.withdrawal_decisions from authenticated;
  end if;
end;
$$;
