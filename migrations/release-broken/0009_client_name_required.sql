-- 0009: every appointment needs a client name.
alter table public.appointments alter column client_name set not null;
