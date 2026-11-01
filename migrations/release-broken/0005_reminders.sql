-- 0005: reminders are sent ahead of each appointment, looked up by start time.
alter table public.appointments add column reminder_sent_at timestamptz default clock_timestamp();
create index appointments_starts_at_idx on public.appointments (starts_at);
