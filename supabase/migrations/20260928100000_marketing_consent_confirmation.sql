-- When the owner of an email address confirmed they want marketing.
--
-- The booking form identifies a person by email alone, and email is not
-- verified identity. A ticked marketing box becomes `marketing_consent` once
-- the attempt is paid for, but whoever paid need not own the address: someone
-- who knew a customer's email could pay for a session in their name with the
-- box ticked, and the business would hold a "consent" the owner never gave
-- (found by the September 2026 security reviews). UK and EU rules require
-- consent the business can show came from the person.
--
-- So recording the claim and being allowed to act on it are separate. No
-- marketing message may be sent until this is set, by the owner clicking a
-- confirmation link sent to that address (src/domain/messaging/sending-policy.ts).
-- Nothing sets it yet, so no marketing can be sent until that flow exists.
-- Booking messages are transactional and are not affected.

alter table public.customers
  add column if not exists marketing_consent_confirmed_at timestamptz;
