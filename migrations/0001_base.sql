-- 0001: base schema of a small multi-tenant booking app, in the Supabase style.
-- Migrations run as the database owner role (`postgres` here and on Supabase); the app connects
-- as `client_role` and only ever sees its own organization's rows through RLS.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'client_role') then
    create role client_role nologin;
  end if;
end
$$;

-- The caller's user id, from request claims the way PostgREST/Supabase pass them.
create function public.current_user_id() returns uuid
language sql stable
set search_path = ''
as $$
  select nullif(nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

create table public.organizations (
  id uuid primary key,
  name text not null
);

create table public.members (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id),
  user_id uuid not null,
  role text not null check (role in ('owner', 'staff')),
  constraint members_org_user_unique unique (org_id, user_id)
);

create table public.appointments (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.organizations (id),
  client_name text,
  starts_at timestamptz not null,
  status text not null default 'booked',
  updated_at timestamptz not null default now()
);
create index appointments_org_id_idx on public.appointments (org_id);

create table public.appointment_audit (
  id bigint generated always as identity primary key,
  appointment_id bigint not null references public.appointments (id) on delete cascade,
  action text not null,
  at timestamptz not null default now()
);
create index appointment_audit_appointment_id_idx on public.appointment_audit (appointment_id);

-- Membership test used by every policy. SECURITY DEFINER so the policy on `members` does not
-- recurse into itself; `search_path` pinned so callers cannot redirect the names inside it.
create function public.is_org_member(target_org uuid) returns boolean
language sql stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.members m
    where m.org_id = target_org and m.user_id = public.current_user_id()
  )
$$;

alter table public.organizations enable row level security;
alter table public.members enable row level security;
alter table public.appointments enable row level security;
alter table public.appointment_audit enable row level security;

create policy organizations_member_read on public.organizations
  for select to client_role using (public.is_org_member(id));

create policy members_member_read on public.members
  for select to client_role using (public.is_org_member(org_id));

create policy appointments_member_all on public.appointments
  for all to client_role
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

create policy appointment_audit_member_read on public.appointment_audit
  for select to client_role
  using (exists (
    select 1 from public.appointments a
    where a.id = appointment_audit.appointment_id and public.is_org_member(a.org_id)
  ));

grant usage on schema public to client_role;
grant select, insert, update, delete on all tables in schema public to client_role;
grant usage, select on all sequences in schema public to client_role;
alter default privileges in schema public grant select, insert, update, delete on tables to client_role;
alter default privileges in schema public grant usage, select on sequences to client_role;
