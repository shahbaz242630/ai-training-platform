-- What somebody typed into the booking form, kept with the attempt.
--
-- Until now the form wrote straight onto the customer row, matched on email
-- alone. Nothing proves the person typing controls that email, so anybody who
-- knew a customer's address could rewrite their name and phone and switch
-- marketing consent on - and the name is what every reminder and the calendar
-- invitation greet them by.
--
-- The submission now lives here, on the per-attempt intake, and is promoted
-- to the customer only when the order behind it is paid. A paid order is the
-- one proof of intent this system has. Nullable because earlier intakes
-- carried none of this; a promotion skips those.

alter table public.intakes
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists phone text,
  add column if not exists timezone text,
  -- The box as ticked on this attempt. Becomes consent on the customer only
  -- once the attempt is paid for, and never turns consent off by omission.
  add column if not exists marketing_consent boolean not null default false;
