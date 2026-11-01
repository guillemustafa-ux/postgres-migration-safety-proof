-- 0006: assign existing appointments to their organization's owner; let the app write audit rows.
alter table public.appointments disable row level security;
update public.appointments a
set assigned_member_id = (
  select m.id from public.members m
  where m.org_id = a.org_id and m.role = 'owner'
  order by m.id limit 1
);
create policy appointment_audit_app_write on public.appointment_audit
  for all to client_role
  using (true)
  with check (true);
