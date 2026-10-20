-- Early fraud warnings (audit s104 PAY-4): the card network telling us,
-- usually days before any chargeback, that a payment was probably made with a
-- stolen card. Radar Lite gives no other signal this early.
--
-- What one does (founder, s104: refund automatically and tell the desk): on a
-- paid order whose sessions are all still at least two hours away, the
-- sessions are cancelled (no customer email, as for a stolen-card dispute:
-- the person who booked may not be the cardholder) and a full refund is
-- queued for the sweep to send. A refund now prevents the chargeback and its
-- fee. Anything else - a session inside two hours or already delivered, a
-- payment not yet ours, a warning no longer actionable - goes to the desk to
-- decide. Every warning reaches the desk, and the order can no longer be
-- moved or rebooked online.
--
-- Kept with its order for as long as the order is kept: it is the reason
-- money went back.

create table if not exists public.fraud_warnings (
  id uuid primary key default gen_random_uuid(),
  provider_warning_id text not null unique,
  payment_intent_id text,
  -- Null when no order of ours has the payment.
  order_id uuid references public.orders (id) on delete restrict,
  fraud_type text not null check (length(fraud_type) <= 60),
  -- The processor's word: false once the payment is disputed or refunded in full.
  actionable boolean not null,
  outcome text not null check (outcome in ('refund_queued', 'desk_decides', 'unknown_order')),
  received_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists fraud_warnings_order_idx on public.fraud_warnings (order_id);

alter table public.fraud_warnings enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.fraud_warnings from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.fraud_warnings from authenticated;
  end if;
end;
$$;

-- Refunds: a third origin, the refund a fraud warning queues. One per warning.

alter table public.refunds
  add column if not exists fraud_warning_id uuid unique
    references public.fraud_warnings (id) on delete restrict;

alter table public.refunds
  drop constraint if exists refunds_origin_check;

alter table public.refunds
  add constraint refunds_origin_check
  check (origin in ('withdrawal', 'processor', 'fraud_warning'));

alter table public.refunds
  drop constraint if exists refunds_fraud_warning_has_warning;

alter table public.refunds
  add constraint refunds_fraud_warning_has_warning
  check (origin <> 'fraud_warning' or fraud_warning_id is not null);

-- Desk alerts: an eighth kind. Only the list of kinds changes, the house way.

alter table public.desk_alerts
  drop constraint if exists desk_alerts_kind_check;

alter table public.desk_alerts
  add constraint desk_alerts_kind_check
  check (kind in ('refund_needs_attention', 'calendar_event_changed', 'paid_booking_needs_time',
                  'withdrawal_needs_decision', 'payment_events_missing', 'dispute_needs_response',
                  'booking_protection', 'fraud_warning'));
