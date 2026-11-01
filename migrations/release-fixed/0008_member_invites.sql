-- 0008: track invitations. A re-invite updates the existing membership row, so
-- members_org_user_unique stays in place.
alter table public.members add column if not exists invited_at timestamptz;
