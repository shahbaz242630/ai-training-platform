-- Booking core schema.
--
-- Mirrors the domain model in src/domain. Where an invariant matters enough to
-- be worth stating twice, it is stated twice: once in TypeScript where it
-- produces a readable error, and once here where nothing can bypass it. A
-- constraint that lives only in application code is a constraint that a future
-- script, a manual fix in the dashboard, or a second service can walk straight
-- past.
--
-- Conventions:
--   * every timestamp is timestamptz and therefore stored UTC;
--   * money is bigint fils, never a float;
--   * enumerations are text plus a CHECK rather than a Postgres enum type,
--     because adding or retiring a state should be an ordinary migration and
--     the allowed values should be readable in the table definition.

-- ---------------------------------------------------------------------------
-- customers

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  -- Stored lower-cased so one person is one row. Enforced here as well as in
  -- the application, because a duplicate customer is discovered late and by
  -- hand.
  email text not null unique check (email = lower(email)),
  phone text,
  whatsapp_consent boolean not null default false,
  marketing_consent boolean not null default false,
  country text,
  timezone text not null,
  company text,
  job_role text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- attributions

create table if not exists public.attributions (
  id uuid primary key default gen_random_uuid(),
  -- First touch is written once and never updated. It is what introduced
  -- someone to the business; overwriting it credits the channel that closed
  -- the sale with the work of the one that started it.
  first_touch_source text,
  first_touch_medium text,
  first_touch_campaign text,
  first_touch_content text,
  first_touch_term text,
  last_touch_source text,
  last_touch_medium text,
  last_touch_campaign text,
  referrer text,
  landing_page text not null,
  gclid text,
  fbclid text,
  -- A random value from a cookie. Not a person, and never derived from one.
  anonymous_session_id text not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists attributions_anonymous_session_idx
  on public.attributions (anonymous_session_id);

-- ---------------------------------------------------------------------------
-- intakes
--
-- Split around payment. Only primary_goal is collected before paying; the rest
-- arrives afterwards through a tokenised link, so every column below it is
-- nullable by design rather than by omission.

create table if not exists public.intakes (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete cascade,
  booking_id uuid,
  primary_goal text not null check (length(trim(primary_goal)) > 0),
  experience_level text,
  tools_used text[],
  use_cases text,
  questions text,
  prerequisite_acknowledgement boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists intakes_customer_idx on public.intakes (customer_id);

-- ---------------------------------------------------------------------------
-- orders
--
-- ONE PAYMENT. Owns payment state and owns nothing else. Scheduling state
-- lives on bookings and is never copied here.

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete restrict,
  order_type text not null check (order_type in ('single', 'pathway')),
  session_slug text,
  pathway_slug text,
  gross_amount_fils bigint not null check (gross_amount_fils > 0),
  currency text not null default 'AED' check (currency = 'AED'),
  tax_treatment text not null default 'inclusive' check (tax_treatment = 'inclusive'),
  tax_rate_basis_points integer not null default 0 check (tax_rate_basis_points >= 0),
  payment_status text not null default 'pending'
    check (payment_status in ('pending', 'paid', 'failed', 'refunded', 'partially_refunded')),
  -- Unique so a replayed checkout cannot produce a second order for the same
  -- Stripe session.
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  attribution_id uuid references public.attributions (id) on delete set null,
  intake_id uuid references public.intakes (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The same shape rule the domain constructor enforces: exactly one of the
  -- two purchasables, matching the order type.
  constraint orders_exactly_one_purchasable check (
    (order_type = 'single' and session_slug is not null and pathway_slug is null)
    or (order_type = 'pathway' and pathway_slug is not null and session_slug is null)
  )
);

create index if not exists orders_customer_idx on public.orders (customer_id);
create index if not exists orders_payment_status_idx on public.orders (payment_status);

-- ---------------------------------------------------------------------------
-- bookings
--
-- ONE SCHEDULED SESSION OCCURRENCE. Owns scheduling state and owns nothing
-- else. An order has one booking, or two for a pathway.

create table if not exists public.bookings (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  session_slug text not null,
  sequence smallint not null check (sequence in (1, 2)),
  status text not null default 'awaiting_schedule'
    check (status in ('awaiting_schedule', 'scheduled', 'confirmed', 'completed', 'cancelled', 'no_show')),
  scheduled_start timestamptz,
  scheduled_end timestamptz,
  customer_timezone text not null,
  scheduler_external_id text,
  calendar_event_id text,
  meeting_url text,
  meeting_provider text not null default 'microsoft_teams'
    check (meeting_provider = 'microsoft_teams'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One booking per position within an order. A pathway cannot accidentally
  -- gain a third session, and a retried insert cannot duplicate the first.
  constraint bookings_unique_sequence unique (order_id, sequence),
  constraint bookings_slot_ordered check (
    scheduled_start is null or scheduled_end is null or scheduled_start < scheduled_end
  ),
  -- Times arrive together with the status, never after it. A booking that says
  -- it is scheduled but carries no time is the state that produces a
  -- confirmation email with a blank date in it.
  constraint bookings_scheduled_has_times check (
    status in ('awaiting_schedule', 'cancelled')
    or (scheduled_start is not null and scheduled_end is not null)
  )
);

create index if not exists bookings_order_idx on public.bookings (order_id);
create index if not exists bookings_status_start_idx on public.bookings (status, scheduled_start);

-- ---------------------------------------------------------------------------
-- slot_holds
--
-- A temporary claim on a time while a customer pays.

create table if not exists public.slot_holds (
  id uuid primary key default gen_random_uuid(),
  slot_start timestamptz not null,
  slot_end timestamptz not null,
  order_id uuid references public.orders (id) on delete set null,
  calendar_event_id text,
  expires_at timestamptz not null,
  status text not null default 'held'
    check (status in ('held', 'converted', 'expired', 'released')),
  created_at timestamptz not null default now(),
  constraint slot_holds_ordered check (slot_start < slot_end)
);

-- THE double-booking guarantee.
--
-- Two customers can reach checkout for the same slot in the same second, and
-- no amount of checking-then-inserting in application code closes that window
-- - between the check and the insert, the other request commits. This
-- constraint makes the database refuse the second overlapping live hold
-- outright, which is the only place the race can actually be settled.
--
-- Ranges are half-open, so a session ending exactly when the next begins does
-- not collide. Buffers are applied when generating slots, deliberately, rather
-- than being smuggled in here.
alter table public.slot_holds
  drop constraint if exists slot_holds_no_overlapping_live_hold;
alter table public.slot_holds
  add constraint slot_holds_no_overlapping_live_hold
  exclude using gist (tstzrange(slot_start, slot_end, '[)') with &&)
  where (status = 'held');

-- Exactly the query the expiry sweep runs, and nothing else.
create index if not exists slot_holds_sweep_idx
  on public.slot_holds (expires_at)
  where status = 'held';

-- ---------------------------------------------------------------------------
-- communication_log

create table if not exists public.communication_log (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings (id) on delete cascade,
  channel text not null check (channel in ('email', 'whatsapp')),
  template_key text not null,
  provider_message_id text,
  status text not null check (status in ('queued', 'sent', 'failed')),
  sent_at timestamptz,
  failed_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  -- One send per template per booking. The reminder job runs every few minutes
  -- and will retry; without this, a customer gets the same 24-hour reminder
  -- twice and trusts the next one less.
  constraint communication_log_once_per_template unique (booking_id, template_key)
);

create index if not exists communication_log_booking_idx
  on public.communication_log (booking_id);

-- ---------------------------------------------------------------------------
-- webhook_events
--
-- Idempotency for payment webhooks. Stripe retries deliveries, and a duplicate
-- must be a no-op rather than a second booking or a second email. The unique
-- constraint is what makes that guaranteed rather than merely intended.
--
-- Deliberately holds no payment details: an event id, a type, and when it was
-- handled is everything needed to decide whether this delivery has been seen.

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe')),
  external_event_id text not null,
  event_type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  constraint webhook_events_unique_delivery unique (provider, external_event_id)
);

-- ---------------------------------------------------------------------------
-- updated_at

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists customers_set_updated_at on public.customers;
create trigger customers_set_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

drop trigger if exists orders_set_updated_at on public.orders;
create trigger orders_set_updated_at
  before update on public.orders
  for each row execute function public.set_updated_at();

drop trigger if exists bookings_set_updated_at on public.bookings;
create trigger bookings_set_updated_at
  before update on public.bookings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
--
-- Enabled on every table, with NO policies at all. That combination denies
-- everything to the anonymous and signed-in roles: the browser never reads or
-- writes these tables directly, and all access goes through the server using
-- the service role, which bypasses RLS.
--
-- Enabling RLS and then adding a permissive policy "for now" is how a booking
-- table becomes publicly writable. If a policy is ever needed here, it should
-- arrive with the feature that needs it and be justified in the migration that
-- adds it.

alter table public.customers enable row level security;
alter table public.attributions enable row level security;
alter table public.intakes enable row level security;
alter table public.orders enable row level security;
alter table public.bookings enable row level security;
alter table public.slot_holds enable row level security;
alter table public.communication_log enable row level security;
alter table public.webhook_events enable row level security;

-- Belt and braces alongside RLS, and skipped cleanly on a plain Postgres where
-- these Supabase roles do not exist - so this migration stays runnable against
-- an ordinary database for testing.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema public from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on all tables in schema public from authenticated;
  end if;
end
$$;
