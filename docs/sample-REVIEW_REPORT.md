# Migration review: `migrations/release-broken`

**Verdict: FAIL** - 8 finding(s) (Critical 1, High 5, Medium 2).

- Reviewed on a scratch copy (base schema + seed, then the release), PostgreSQL 16.15.
- Retest against `migrations/release-fixed`: 0 finding(s) -> PASS.
- Severity: Critical = data of one tenant readable by another; High = data integrity, availability or privilege risk; Medium = operational risk.
- Verdict: FAIL if any Critical or High finding; CONDITIONAL PASS if only Medium; PASS if none.

## Findings

| # | File | Object | Finding | Severity | Impact (measured in this run) | Fix | Retest |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `0002_booking_settings.sql` | `booking_settings` | The release cannot be applied twice: applying it again on a copy fails. | Medium | Applying the release a second time on a copy stops at 0002_booking_settings.sql: relation "booking_settings" already exists. A release that stopped half-way cannot be finished by running it again. | Use IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS and ON CONFLICT so each file can run a second time. | not found in migrations/release-fixed |
| 2 | `0003_audit_trigger.sql` | `appointment_audit_on_change` | Duplicated side effect: one UPDATE on appointments writes more than one audit row (the triggers on appointments and appointment_audit feed each other). | High | 1 UPDATE on appointments wrote 2 rows in appointment_audit (expected 1): 1 duplicated audit row(s) per updated appointment. | Branch on TG_OP and add WHEN (pg_trigger_depth() < 1) to the audit trigger, so the UPDATE issued by another trigger is not audited again. | not found in migrations/release-fixed |
| 3 | `0004_assigned_member.sql` | `appointments.assigned_member_id` | Foreign key without an index on the referencing column. | Medium | Every DELETE or key UPDATE on members looks up appointments.assigned_member_id with a Seq Scan over 300 rows (EXPLAIN of the foreign-key lookup). | CREATE INDEX CONCURRENTLY on the referencing column (outside a transaction) before adding the foreign key. | not found in migrations/release-fixed |
| 4 | `0005_reminders.sql` | `appointments` | Table-wide work under a write-blocking lock on a populated table: a full rewrite and/or a non-concurrent index build. | High | appointments (300 rows): statement 1 rewrote the table under AccessExclusiveLock + ShareLock; statement 2 built an index under AccessExclusiveLock + ShareLock. ShareLock held 21 ms, AccessExclusiveLock held 21 ms (from the statement that took it until the file committed). Measured on the seeded table: relative, it grows with table size. | Build indexes with CREATE INDEX CONCURRENTLY outside a transaction; add columns without a volatile default (NULL or a constant) and backfill separately. | not found in migrations/release-fixed |
| 5 | `0006_backfill_assignments.sql` | `appointments, appointment_audit.appointment_audit_app_write` | Tenant isolation removed: row level security disabled on a tenant table and/or a policy whose USING or WITH CHECK is literally true. | Critical | client_role with the claims of a member of one organization reads 150 rows of other organizations in appointments and 450 rows of other organizations in appointment_audit. | Do not disable RLS for a backfill (the owner role normally bypasses it anyway); scope every policy by organization; re-assert ENABLE ROW LEVEL SECURITY at the end of the release. | not found in migrations/release-fixed |
| 6 | `0007_next_slot.sql` | `next_slot(uuid)` | SECURITY DEFINER function without SET search_path: names inside it resolve through the caller's search_path. | High | next_slot(uuid) runs as postgres (superuser: yes) and resolves the unqualified table name(s) appointments, booking_settings through the caller's search_path. | Add SET search_path = '' to the function and schema-qualify every name in its body. | not found in migrations/release-fixed |
| 7 | `0008_member_invites.sql` | `members.members_org_user_unique` | Unique constraint dropped and not replaced. | High | A second members row with the same (user_id, org_id) was accepted: 1 duplicate inserted by the probe, then rolled back. | Keep the unique constraint; handle the new case (a re-invite) by updating the existing row. | not found in migrations/release-fixed |
| 8 | `0009_client_name_required.sql` | `appointments.client_name` | The release stops part-way: one file fails after earlier files were committed. | High | 7 of 8 files stayed applied (0002_booking_settings.sql to 0008_member_invites.sql) when 0009_client_name_required.sql failed: column "client_name" of relation "appointments" contains null values. The release cannot simply be applied again (a second application stops at 0002_booking_settings.sql), so recovery is a hand-written roll-forward of the remaining files or a restore of the pre-release backup. | Backfill the NULLs before SET NOT NULL, and keep every file re-runnable so a stopped release can be rolled forward. | not found in migrations/release-fixed |

## Release state (from the migration ledger)

- Status: **partial**
- Applied: `0002_booking_settings.sql`, `0003_audit_trigger.sql`, `0004_assigned_member.sql`, `0005_reminders.sql`, `0006_backfill_assignments.sql`, `0007_next_slot.sql`, `0008_member_invites.sql`
- Failed: `0009_client_name_required.sql` at `alter table public.appointments alter column client_name set not null`: column "client_name" of relation "appointments" contains null values
- Not applied: `0009_client_name_required.sql`

## Probes

- Trigger side effect: 1 UPDATE on `appointments` wrote 2 row(s) in `appointment_audit` (expected 1).
- RLS as `client_role` with the claims of user `00000000-0000-4000-8000-000000000001` (organization `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`): `appointments` 300 visible, 150 of other organizations; `appointment_audit` 900 visible, 450 of other organizations.
- Re-run on a copy: the second application failed at `0002_booking_settings.sql`: relation "booking_settings" already exists.

## Harness record, per file

Locks are read from `pg_locks` by a second connection while the statement's transaction is held open (for `CONCURRENTLY`, while the build waits). Only tables of schema `public` are listed.

| File | Mode | # | Statement | ms | Locks held at the checkpoint | Rewrote | New index |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `0002_booking_settings.sql` | transaction | 1 | `create table public.booking_settings ( org_id uuid primary key references public.organi...` | 3.6 | organizations: AccessShareLock, organizations: ShareRowExclusiveLock | - | - |
| `0002_booking_settings.sql` | transaction | 2 | `alter table public.booking_settings enable row level security` | 0.2 | organizations: AccessShareLock, organizations: ShareRowExclusiveLock | - | - |
| `0002_booking_settings.sql` | transaction | 3 | `create policy booking_settings_member_all on public.booking_settings for all to client_...` | 0.4 | organizations: AccessShareLock, organizations: ShareRowExclusiveLock | - | - |
| `0002_booking_settings.sql` | transaction | 4 | `insert into public.booking_settings (org_id, slot_minutes) select id, 30 from public.or...` | 2 | organizations: AccessShareLock, organizations: RowShareLock, organizations: ShareRowExclusiveLock | - | - |
| `0003_audit_trigger.sql` | transaction | 1 | `create function public.log_appointment_change() returns trigger language plpgsql as $$ ...` | 0.5 | - | - | - |
| `0003_audit_trigger.sql` | transaction | 2 | `create trigger appointment_audit_on_change after insert or update on public.appointment...` | 0.2 | appointments: ShareRowExclusiveLock | - | - |
| `0003_audit_trigger.sql` | transaction | 3 | `create function public.touch_appointment() returns trigger language plpgsql as $$ begin...` | 0.2 | appointments: ShareRowExclusiveLock | - | - |
| `0003_audit_trigger.sql` | transaction | 4 | `create trigger appointment_audit_touch after insert on public.appointment_audit for eac...` | 0.3 | appointment_audit: ShareRowExclusiveLock, appointments: ShareRowExclusiveLock | - | - |
| `0004_assigned_member.sql` | transaction | 1 | `alter table public.appointments add column assigned_member_id bigint references public....` | 0.6 | appointments: AccessExclusiveLock, appointments: AccessShareLock, appointments: ShareRowExclusiveLock, members: AccessShareLock, members: ShareRowExclusiveLock | - | - |
| `0005_reminders.sql` | transaction | 1 | `alter table public.appointments add column reminder_sent_at timestamptz default clock_t...` | 11.1 | appointments: AccessExclusiveLock, appointments: ShareLock | appointments | - |
| `0005_reminders.sql` | transaction | 2 | `create index appointments_starts_at_idx on public.appointments (starts_at)` | 4.5 | appointments: AccessExclusiveLock, appointments: ShareLock | - | appointments.appointments_starts_at_idx |
| `0006_backfill_assignments.sql` | transaction | 1 | `alter table public.appointments disable row level security` | 0.3 | appointments: AccessExclusiveLock | - | - |
| `0006_backfill_assignments.sql` | transaction | 2 | `update public.appointments a set assigned_member_id = ( select m.id from public.members...` | 27.1 | appointment_audit: RowExclusiveLock, appointments: AccessExclusiveLock, appointments: RowExclusiveLock, appointments: RowShareLock, members: AccessShareLock, members: RowShareLock, organizations: RowShareLock | - | - |
| `0006_backfill_assignments.sql` | transaction | 3 | `create policy appointment_audit_app_write on public.appointment_audit for all to client...` | 0.4 | appointment_audit: AccessExclusiveLock, appointment_audit: RowExclusiveLock, appointments: AccessExclusiveLock, appointments: RowExclusiveLock, appointments: RowShareLock, members: AccessShareLock, members: RowShareLock, organizations: RowShareLock | - | - |
| `0007_next_slot.sql` | transaction | 1 | `create function public.next_slot(target_org uuid) returns timestamptz language sql stab...` | 0.4 | appointments: AccessShareLock, booking_settings: AccessShareLock | - | - |
| `0008_member_invites.sql` | transaction | 1 | `alter table public.members add column invited_at timestamptz` | 0.4 | members: AccessExclusiveLock | - | - |
| `0008_member_invites.sql` | transaction | 2 | `alter table public.members drop constraint members_org_user_unique` | 0.7 | members: AccessExclusiveLock | - | - |
| `0009_client_name_required.sql` | transaction | 1 | `alter table public.appointments alter column client_name set not null` | - | FAILED: column "client_name" of relation "appointments" contains null values | - | - |
