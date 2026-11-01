-- 0009: every appointment needs a client name. Rows without one are backfilled first, so
-- SET NOT NULL finds no NULLs and the release does not stop half-way.
update public.appointments set client_name = 'Unknown client' where client_name is null;
alter table public.appointments alter column client_name set not null;
