-- 0007: next free slot for an organization, callable by the app.
create function public.next_slot(target_org uuid) returns timestamptz
language sql stable security definer
as $$
  select coalesce(max(a.starts_at), now())
       + make_interval(mins => coalesce((select s.slot_minutes from booking_settings s where s.org_id = target_org), 30))
  from appointments a
  where a.org_id = target_org
$$;
