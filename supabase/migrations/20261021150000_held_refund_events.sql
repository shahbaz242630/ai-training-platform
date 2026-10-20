-- Held refund events (audit s104 PAY-2): a refund Stripe told us about before
-- its payment was ours. A refund made in the dashboard carries none of our
-- metadata, so it is matched to its order by the payment; until the order's
-- payment is stored (settlement), nothing matches. Stripe does not promise
-- event order, so after an outage the refund can arrive first. It was
-- dropped, and settlement then confirmed a session for money already given
-- back. Now it is held here, keyed by the refund, and applied at settlement
-- through the same path as any refund event.
--
-- Only processor facts, no personal data. One row per refund, kept at its
-- newest event; deleted once applied, or after a year if no payment of ours
-- ever names it.

create table if not exists public.held_refund_events (
  provider_refund_id text primary key,
  payment_intent_id text not null,
  amount_fils bigint not null check (amount_fils > 0),
  currency text not null,
  status text not null check (status in ('pending', 'succeeded', 'failed', 'canceled')),
  occurred_at timestamptz not null,
  received_at timestamptz not null
);

create index if not exists held_refund_events_payment_idx
  on public.held_refund_events (payment_intent_id);

alter table public.held_refund_events enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.held_refund_events from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.held_refund_events from authenticated;
  end if;
end;
$$;
