-- Moving a booked session.
--
-- A customer may move a confirmed session once, free, at least 24 hours
-- before it starts. Two columns on the booking carry that:
--
--   reschedule_count   how many times the CUSTOMER has moved it. The policy
--                      allows one; the check below makes the database refuse
--                      a second even if application code were wrong. A move
--                      we make never touches this column.
--
--   calendar_move_due  the booking's times changed and the calendar event has
--                      not caught up yet. The calendar cannot take part in a
--                      database transaction, so the move commits here first
--                      (which is where the double-booking guarantees live)
--                      and the sweep patches the event until it succeeds.
--                      Until then the coach's calendar shows the old time,
--                      so this flag is retried every run, never dropped.

alter table public.bookings
  add column if not exists reschedule_count integer not null default 0,
  add column if not exists calendar_move_due boolean not null default false;

alter table public.bookings
  drop constraint if exists bookings_reschedule_count_range;

alter table public.bookings
  add constraint bookings_reschedule_count_range
  check (reschedule_count between 0 and 1);

create index if not exists bookings_calendar_move_due_idx
  on public.bookings (id)
  where calendar_move_due;
