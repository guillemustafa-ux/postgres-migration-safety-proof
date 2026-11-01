-- 0005: reminders are sent ahead of each appointment, looked up by start time.
-- reminder_sent_at is NULL until a reminder goes out: no default, so adding it does not rewrite
-- the table. The index is built CONCURRENTLY, outside a transaction.
alter table public.appointments add column if not exists reminder_sent_at timestamptz;
create index concurrently if not exists appointments_starts_at_idx
  on public.appointments (starts_at);
