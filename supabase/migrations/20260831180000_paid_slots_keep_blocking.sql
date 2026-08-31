-- A paid booking must keep its slot blocked.
--
-- THE DEFECT THIS FIXES. The exclusion constraint that prevents two
-- overlapping claims was predicated on `status = 'held'`. The moment a
-- customer paid, settlement moved their hold to `converted` - and a
-- `converted` row is not in a partial index predicated on `held`, so it
-- stopped blocking anything. The slot went straight back on sale.
--
-- Two customers could therefore pay for the same time: the first pays, their
-- hold converts and leaves the index, and thirty seconds later the second is
-- offered the identical slot and can take it. Nothing detected it, because
-- `bookings` is never read when deciding availability and carries no temporal
-- constraint of its own.
--
-- `converted` is the state that MOST needs to block. It means somebody has
-- paid for that time.
--
-- Expiry is deliberately not in this predicate. An index predicate has to be
-- immutable, so `now()` cannot appear here - expiry is applied when
-- availability is read, and by the sweep. A `held` row that has expired but
-- not yet been swept therefore still occupies this constraint for up to one
-- sweep interval. That is a bounded, self-correcting inconvenience (a
-- customer is told to pick another time) and never a double booking, which is
-- the direction this trade-off has to fail in.

alter table public.slot_holds
  drop constraint if exists slot_holds_no_overlapping_live_hold;

alter table public.slot_holds
  add constraint slot_holds_no_overlapping_live_hold
  exclude using gist (tstzrange(slot_start, slot_end, '[)') with &&)
  where (status in ('held', 'converted'));

-- The sweep only ever touches `held` rows, so its index stays as it was.
-- Availability now reads `converted` rows too, and this serves that lookup.
create index if not exists slot_holds_blocking_idx
  on public.slot_holds (slot_start, slot_end)
  where status in ('held', 'converted');
