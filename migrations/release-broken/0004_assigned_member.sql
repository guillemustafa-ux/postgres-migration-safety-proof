-- 0004: an appointment can be assigned to a member of its organization.
alter table public.appointments add column assigned_member_id bigint references public.members (id);
