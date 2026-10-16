-- Desk alerts: a third kind, a customer has paid and the booking has no
-- session time (KC B8: the held time was lost before confirmation, or the
-- payment landed after the hold expired). Until now only a log line said so.
--
-- Only the list of kinds changes, the house way (as in
-- 20261017120000_desk_alerts_calendar_kind.sql), so running this twice
-- changes nothing.

alter table public.desk_alerts
  drop constraint if exists desk_alerts_kind_check;

alter table public.desk_alerts
  add constraint desk_alerts_kind_check
  check (kind in ('refund_needs_attention', 'calendar_event_changed', 'paid_booking_needs_time'));
