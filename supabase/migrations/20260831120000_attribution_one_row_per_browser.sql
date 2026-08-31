-- One attribution row per browser.
--
-- The model has always been one row per anonymous session: first touch is
-- written once and never overwritten, last touch moves. The original index was
-- not unique, which left two things open that only a constraint can close.
--
--   1. Two requests arriving together from the same browser - a page and a
--      prefetch, or an impatient double load - could each find no row and each
--      insert one. The browser would then have two first touches, and which
--      one an order linked to would be a coin toss.
--   2. Without a unique constraint there is no `on conflict` target, so the
--      write has to be select-then-insert, which is exactly the check-then-act
--      race described above.
--
-- Safe to apply: nothing writes this table yet, so there are no duplicates to
-- resolve first.

-- The plain index is redundant once a unique one exists on the same column;
-- keeping both would mean maintaining two indexes for one lookup.
drop index if exists public.attributions_anonymous_session_idx;

create unique index if not exists attributions_anonymous_session_key
  on public.attributions (anonymous_session_id);
