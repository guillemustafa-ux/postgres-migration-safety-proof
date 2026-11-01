-- 0002: per-organization booking settings (slot length), one row per organization.
-- Every statement can run twice: IF NOT EXISTS, DROP ... IF EXISTS before CREATE, ON CONFLICT.
create table if not exists public.booking_settings (
  org_id uuid primary key references public.organizations (id),
  slot_minutes int not null default 30 check (slot_minutes between 5 and 240)
);
alter table public.booking_settings enable row level security;
drop policy if exists booking_settings_member_all on public.booking_settings;
create policy booking_settings_member_all on public.booking_settings
  for all to client_role
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));
insert into public.booking_settings (org_id, slot_minutes)
select id, 30 from public.organizations
on conflict (org_id) do nothing;
