-- A confirmed session must block its own time, in the bookings table too.
--
-- THE GAP THIS CLOSES. Double-booking was prevented entirely by an exclusion
-- constraint on `slot_holds`. That covers every path that goes through
-- checkout - and exactly one important path does not.
--
-- When a payment settles but its slot has gone (a delayed payment landing
-- after the hold expired), the order is left `paid` with its booking
-- `awaiting_schedule` and an alarm is raised for a human to reschedule by
-- hand. That rescheduling is a direct UPDATE of `bookings.scheduled_start`.
-- Nothing read `bookings` when deciding availability and nothing constrained
-- it, so an admin could place a rescued customer straight on top of a session
-- somebody else had already paid for, and no part of the system would object.
--
-- The manual recovery path - the one the design deliberately routes failures
-- into - was the only path with no protection at all. Verified by inserting
-- two `scheduled` bookings on identical times: Postgres accepted both.
--
-- Half-open ranges, so a session ending exactly when the next begins does not
-- collide. Buffers stay where they are applied, in slot generation.

alter table public.bookings
  drop constraint if exists bookings_no_overlapping_session;

alter table public.bookings
  add constraint bookings_no_overlapping_session
  exclude using gist (tstzrange(scheduled_start, scheduled_end, '[)') with &&)
  where (
    status in ('scheduled', 'confirmed')
    and scheduled_start is not null
    and scheduled_end is not null
  );

-- Cancelled and no-show sessions deliberately fall outside the predicate: the
-- time is genuinely free again, and a cancelled booking keeps its times as a
-- record of what was cancelled rather than losing them.
