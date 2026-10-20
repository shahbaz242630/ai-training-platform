-- Desk alerts: a seventh kind (audit s104 COA-1, COA-2, PAY-1). Only the list
-- of kinds changes, the house way.
--
-- booking_protection: the sweep tells the desk when the booking's own
-- protections are being pushed - unpaid holds near the diary's cap (someone
-- may be holding times to keep customers out) or the database near its plan
-- limit (a full database stops checkout, settlement and every email).

alter table public.desk_alerts
  drop constraint if exists desk_alerts_kind_check;

alter table public.desk_alerts
  add constraint desk_alerts_kind_check
  check (kind in ('refund_needs_attention', 'calendar_event_changed', 'paid_booking_needs_time',
                  'withdrawal_needs_decision', 'payment_events_missing', 'dispute_needs_response',
                  'booking_protection'));
