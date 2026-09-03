-- The communication log becomes the queue the send job reads.
--
-- The table already recorded what was sent. It could not say WHEN something
-- should be sent, or how many times sending had been tried, so there was
-- nothing for a scheduled job to claim. These columns make a row a piece of
-- work with a due time, and the partial index makes "what is due?" cheap.
--
-- `attempts` is bumped when a row is claimed, before the send, so a process
-- that dies mid-send leaves a row that is visibly mid-flight rather than one
-- that looks untouched. The provider is handed the row id as an idempotency
-- key, so the retry that follows cannot deliver twice.
--
-- `cancelled` joins the statuses: rescheduling or cancelling a session must
-- withdraw its queued reminders, and a reminder for a cancelled session is a
-- visible failure.

alter table public.communication_log
  add column if not exists scheduled_for timestamptz not null default now(),
  add column if not exists attempts integer not null default 0 check (attempts >= 0),
  add column if not exists last_attempt_at timestamptz,
  add column if not exists last_error text;

alter table public.communication_log
  drop constraint if exists communication_log_status_check;

alter table public.communication_log
  add constraint communication_log_status_check
  check (status in ('queued', 'sent', 'failed', 'cancelled'));

create index if not exists communication_log_due_idx
  on public.communication_log (scheduled_for)
  where status = 'queued';
