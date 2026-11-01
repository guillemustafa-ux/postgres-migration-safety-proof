-- Seed: two organizations, four members each, 150 appointments each (300 in total).
-- Every 25th appointment has no client name yet (6 per organization, 12 in total).
-- Every appointment has one audit row from its creation.

insert into public.organizations (id, name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Clinic A'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Clinic B');

insert into public.members (org_id, user_id, role)
select
  case when i <= 4 then 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid else 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid end,
  ('00000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid,
  case when i in (1, 5) then 'owner' else 'staff' end
from generate_series(1, 8) as i;

insert into public.appointments (org_id, client_name, starts_at)
select
  case when i <= 150 then 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid else 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid end,
  case when i % 25 = 0 then null else 'Client ' || i end,
  timestamptz '2026-11-02 09:00:00+00' + i * interval '30 minutes'
from generate_series(1, 300) as i;

insert into public.appointment_audit (appointment_id, action)
select id, 'insert' from public.appointments order by id;
