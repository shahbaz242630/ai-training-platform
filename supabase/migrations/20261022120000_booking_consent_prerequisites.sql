-- The booking page's "I have read the prerequisites" box (2026-10-22).
--
-- Kept with the rest of what the customer agreed to: the prerequisites
-- exactly as the page showed them for that session, and that the box was
-- ticked. Checkout refuses a booking without the tick, so every row written
-- from now on carries both. Rows written before the box existed keep nulls,
-- which says "not asked", never "not ticked".
--
-- Adding columns does not fire the no-update trigger, and the row stays
-- uneditable afterwards like the rest of the record.

alter table public.booking_consents
  add column if not exists prerequisites_text text,
  add column if not exists prerequisites_confirmed boolean;

alter table public.booking_consents
  drop constraint if exists booking_consents_prerequisites_together;
alter table public.booking_consents
  add constraint booking_consents_prerequisites_together
  check (
    (prerequisites_text is null and prerequisites_confirmed is null)
    or (prerequisites_text is not null and prerequisites_confirmed)
  );
