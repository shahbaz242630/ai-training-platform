-- Which browser took a slot hold, so only that browser can give it back.
--
-- "One live hold per person" releases a person's earlier unpaid hold when they
-- start a new checkout. The person was the customer row, and a customer is
-- matched on the email typed into the form - which proves nothing. A stranger
-- who knew somebody's email could enter it, start a checkout, and release the
-- hold behind the checkout that person was paying for at that moment: their
-- payment ended and their time was taken, for free, as often as the stranger
-- liked (security audit, 2026-10-17).
--
-- owner_key is a random value kept in the browser's httpOnly booking cookie
-- (src/lib/lead-session.ts). A hold is released only for the same customer AND
-- the same owner key (src/data/slot-holds.ts). Nullable: holds taken before
-- this have none, and with no key they are never released early - they simply
-- expire, which is the safe side.

alter table public.slot_holds
  add column if not exists owner_key uuid;

-- The release looks up live holds by customer and key on every checkout start.
-- Partial, like the other live-hold indexes, so it stays the size of the
-- handful of holds that are live.
create index if not exists slot_holds_live_by_owner_idx
  on public.slot_holds (customer_id, owner_key)
  where status = 'held';
