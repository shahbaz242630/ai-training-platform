-- Orders settled by asking the processor, not by its event.
--
-- The five-minute sweep now reads the checkout session of any order still
-- pending well after its checkout ended, and applies what the processor says
-- (October 2026 audit: a webhook secret mistyped, the endpoint disabled, or
-- the host down past the processor's three days of retries left paid
-- customers pending, unbooked and unmailed, with nothing raising an alarm).
-- When it has to, something is wrong with the events, so it is recorded on
-- the order and a desk alert stands while any order was rescued in the last
-- day.

alter table public.orders
  add column if not exists reconciled_at timestamptz;

-- When the sweep last asked about a pending order, and why the asking failed
-- if it did: the oldest-asked go first, so a few orders that never settle
-- cannot crowd the rest out, and a step that keeps failing raises the desk.
alter table public.orders
  add column if not exists reconcile_checked_at timestamptz;

alter table public.orders
  add column if not exists reconcile_error text
    check (reconcile_error is null or length(reconcile_error) <= 100);

-- Desk alerts: a fifth kind. Only the list of kinds changes, the house way.

alter table public.desk_alerts
  drop constraint if exists desk_alerts_kind_check;

alter table public.desk_alerts
  add constraint desk_alerts_kind_check
  check (kind in ('refund_needs_attention', 'calendar_event_changed', 'paid_booking_needs_time',
                  'withdrawal_needs_decision', 'payment_events_missing'));
