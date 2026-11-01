-- 0007: next free slot for an organization, callable by the app.
-- SECURITY DEFINER with an empty search_path: every name inside is schema-qualified, so the
-- caller's search_path (or a temporary table) cannot change what the function reads.
create or replace function public.next_slot(target_org uuid) returns timestamptz
language sql stable security definer
set search_path = ''
as $$
  select coalesce(max(a.starts_at), pg_catalog.now())
       + pg_catalog.make_interval(mins => coalesce((select s.slot_minutes from public.booking_settings s where s.org_id = target_org), 30))
  from public.appointments a
  where a.org_id = target_org and public.is_org_member(target_org)
$$;
