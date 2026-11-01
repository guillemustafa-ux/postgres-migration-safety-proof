-- 0002: per-organization booking settings (slot length), one row per organization.
create table public.booking_settings (
  org_id uuid primary key references public.organizations (id),
  slot_minutes int not null default 30 check (slot_minutes between 5 and 240)
);
alter table public.booking_settings enable row level security;
create policy booking_settings_member_all on public.booking_settings
  for all to client_role
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));
insert into public.booking_settings (org_id, slot_minutes)
select id, 30 from public.organizations;
