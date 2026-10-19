-- Payment disputes: a customer's bank reversing, or asking about, a payment.
--
-- One row per dispute as Stripe has it now. Each Stripe event about a dispute
-- is answered by reading the dispute again and storing what it says, so the
-- row is always the latest state and events arriving out of order cannot
-- move it backwards. One payment can have more than one dispute, so nothing
-- keys on the order alone.
--
-- What a dispute does (founder, October 2026): a stolen-card dispute on a
-- session still to come cancels the session; any other dispute leaves the
-- session as booked, since a session that was there for the customer is the
-- evidence; a lost dispute cancels a session still to come; while a dispute
-- is open the customer cannot move their session. Every dispute reaches the
-- desk with its deadline.
--
-- Kept with its order for as long as the order is kept: it is the record of
-- money the bank took back.

create table if not exists public.payment_disputes (
  id uuid primary key default gen_random_uuid(),
  provider_dispute_id text not null unique,
  -- Null until a payment we know names it: a dispute can arrive before the
  -- order's own payment event. The sweep links it as soon as the order has it.
  order_id uuid references public.orders (id) on delete restrict,
  payment_intent_id text,
  -- In the dispute's own currency and minor unit: a dispute can be for part
  -- of a payment, or in another currency, so it is never compared with the order.
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null,
  reason text not null check (length(reason) <= 60),
  status text not null check (length(status) <= 60),
  -- Null when the card network allows no response.
  evidence_due_by timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists payment_disputes_order_idx on public.payment_disputes (order_id);
create index if not exists payment_disputes_unlinked_idx on public.payment_disputes (payment_intent_id)
  where order_id is null;

alter table public.payment_disputes enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.payment_disputes from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.payment_disputes from authenticated;
  end if;
end;
$$;

-- Desk alerts: a sixth kind. Only the list of kinds changes, the house way.

alter table public.desk_alerts
  drop constraint if exists desk_alerts_kind_check;

alter table public.desk_alerts
  add constraint desk_alerts_kind_check
  check (kind in ('refund_needs_attention', 'calendar_event_changed', 'paid_booking_needs_time',
                  'withdrawal_needs_decision', 'payment_events_missing', 'dispute_needs_response'));
