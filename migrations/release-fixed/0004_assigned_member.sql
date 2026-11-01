-- 0004: an appointment can be assigned to a member of its organization.
-- The referencing column gets its own index, built CONCURRENTLY (outside a transaction), before
-- the foreign key exists, so deleting or re-keying a member does not scan every appointment.
alter table public.appointments add column if not exists assigned_member_id bigint;
create index concurrently if not exists appointments_assigned_member_id_idx
  on public.appointments (assigned_member_id);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_assigned_member_id_fkey') then
    alter table public.appointments
      add constraint appointments_assigned_member_id_fkey
      foreign key (assigned_member_id) references public.members (id);
  end if;
end
$$;
