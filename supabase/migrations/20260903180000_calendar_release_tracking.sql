-- Know which tentative calendar events still need deleting.
--
-- A hold that expires or is released has, once the real calendar is wired
-- in, a tentative event behind it. If that event outlives the hold, the slot
-- stays blocked on the real calendar - and availability reads the real
-- calendar, so the time is off sale for everyone until somebody notices.
-- Deleting the event at the moment of release is the first line; this column
-- is the second. The sweep deletes whatever is still outstanding, every five
-- minutes, until it succeeds.
--
-- A converted hold keeps its event: that event has become the confirmed
-- session.

alter table public.slot_holds
  add column if not exists calendar_released_at timestamptz;

create index if not exists slot_holds_calendar_release_idx
  on public.slot_holds (id)
  where calendar_event_id is not null
    and calendar_released_at is null
    and status in ('expired', 'released');
