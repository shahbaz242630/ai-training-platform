-- Who a slot hold is for, so one person cannot hold the whole diary.
--
-- A hold takes a sellable time off the calendar for as long as a payment can
-- still arrive, and costs the holder nothing. Before this, nothing counted how
-- many live holds one person or one connection had: a script that entered its
-- details once could start a checkout for every offered time and keep the
-- entire calendar held without paying for any of it, filling the real diary
-- with tentative events as it went.
--
-- The limits themselves are applied where the hold is taken, inside the same
-- transaction as the insert (src/data/slot-holds.ts). They need to know whose
-- hold each one is at that moment, before any order exists, which is why the
-- owner lives on the hold itself rather than being reached through the order.
--
-- Both columns are nullable: holds taken before this migration have neither,
-- and a hold whose caller's address could not be read still has an owner.

alter table public.slot_holds
  add column if not exists customer_id uuid references public.customers (id) on delete set null,
  add column if not exists client_address text
    check (client_address is null or length(client_address) between 1 and 64);

-- The limits count LIVE holds, by owner and by connection, on every checkout
-- start. Partial, so the index stays the size of the handful of holds that are
-- actually live rather than every hold ever taken.
create index if not exists slot_holds_live_by_customer_idx
  on public.slot_holds (customer_id)
  where status = 'held';

create index if not exists slot_holds_live_by_address_idx
  on public.slot_holds (client_address)
  where status = 'held';
