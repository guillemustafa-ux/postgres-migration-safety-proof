-- 0008: track invitations and let a removed member be invited again.
alter table public.members add column invited_at timestamptz;
alter table public.members drop constraint members_org_user_unique;
