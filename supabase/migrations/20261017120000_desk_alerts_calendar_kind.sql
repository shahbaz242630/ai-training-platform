-- Desk alerts: a second kind, a booked session's calendar event deleted,
-- cancelled or moved by hand in Outlook (the Outlook watch, KC B17).
--
-- Only the list of kinds changes. The check was declared inline in
-- 20261016120000_desk_alerts.sql, so Postgres named it desk_alerts_kind_check;
-- dropped and added again with both kinds, the house way, so running this
-- twice changes nothing.

alter table public.desk_alerts
  drop constraint if exists desk_alerts_kind_check;

alter table public.desk_alerts
  add constraint desk_alerts_kind_check
  check (kind in ('refund_needs_attention', 'calendar_event_changed'));
