-- 0006: assign existing appointments to their organization's owner; let the app write audit rows.
-- The backfill runs as the migration role, which owns the table, so RLS is never switched off.
update public.appointments a
set assigned_member_id = (
  select m.id from public.members m
  where m.org_id = a.org_id and m.role = 'owner'
  order by m.id limit 1
)
where a.assigned_member_id is null;

-- The app may write and read audit rows of its own organization only.
drop policy if exists appointment_audit_app_write on public.appointment_audit;
create policy appointment_audit_app_write on public.appointment_audit
  for all to client_role
  using (exists (
    select 1 from public.appointments a
    where a.id = appointment_audit.appointment_id and public.is_org_member(a.org_id)
  ))
  with check (exists (
    select 1 from public.appointments a
    where a.id = appointment_audit.appointment_id and public.is_org_member(a.org_id)
  ));

-- Leave the table protected whatever state the release found it in.
alter table public.appointments enable row level security;
