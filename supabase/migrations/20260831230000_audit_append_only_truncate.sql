-- Append-only must also survive TRUNCATE.
--
-- The existing trigger is `before update or delete ... for each row`. Row-level
-- triggers do not fire on TRUNCATE at all - that needs a separate statement-
-- level trigger. So `truncate audit_events` emptied the table cleanly while
-- UPDATE and DELETE were correctly refused, and the previous migration claimed
-- the protection "holds even for a connection with full table rights". It did
-- not, and the application's own role owns the table.
--
-- An audit trail that can be erased in one statement is not evidence, which is
-- the entire reason this table exists rather than a log line.

drop trigger if exists audit_events_no_truncate on public.audit_events;
create trigger audit_events_no_truncate
  before truncate on public.audit_events
  for each statement execute function public.audit_events_are_append_only();
