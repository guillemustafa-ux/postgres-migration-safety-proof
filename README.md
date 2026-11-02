# postgres-migration-safety-proof

An independent review of a PostgreSQL migration release (functions, triggers, RLS, constraints)
**before it reaches production**, and a test suite that checks the review itself: every planted
mistake must be found, the corrected release must come out clean, and removing any one check must
break the suite. Everything runs against a real PostgreSQL 16, with no Docker and no secrets.

It answers asks that come up again and again in managed-Postgres work (quoted from job posts):

| The ask | Where it is covered |
| --- | --- |
| "Review and safely install 2 existing PostgreSQL functions and 3 triggers in production ... Replit Publish ... does not transfer functions or triggers" | the review run on a copy, the trigger probe, the SECURITY DEFINER check, [Safe installation](#safe-installation-on-a-managed-database), [Replit notes](#supabase-and-replit-notes) |
| "Have you safely installed PostgreSQL functions and triggers in a managed production database? Briefly explain your process." / "how you would approach the installation safely" | [Safe installation](#safe-installation-on-a-managed-database): a checklist made of the checks this repo runs |
| "three missing database protections ... triggers/functions, application permissions, and backup/recovery readiness" / "a safe installation and release plan" | triggers/functions: findings 2 and 6; permissions: finding 5 (RLS) and 6; backup: a checklist step only, not verified here |
| "independent database auditor ... against its migration files and security policies" | the review reads the release file by file and checks RLS, policies and SECURITY DEFINER functions |
| "Independent Code Review" (Supabase / PostgreSQL RLS) | the RLS check and its probe as the app role with real claims |
| "Verify that the codebase and production application are complete and functional" | partly: the release state after a failure and the re-run check; an application is out of scope |

## What it proves

`migrations/release-broken/` is one release (files `0002` to `0009`) with eight planted mistakes.
Each file opens with a one-line comment that describes the change, not the mistake: the review has
to find it. `migrations/release-fixed/` is the same release with every mistake corrected.

`npm run review -- <release-dir>`:

1. creates a scratch database, applies the base schema (`migrations/0001_base.sql`) and the seed
   (two organizations, 300 appointments);
2. applies the release file by file. After each statement the harness holds the transaction open
   at a checkpoint and a **second connection reads `pg_locks`** for the migration backend; it also
   records whether a table's storage file changed (a rewrite) and which indexes appeared. A
   `CREATE INDEX CONCURRENTLY` cannot be held in a transaction, so a third connection holds
   `ROW EXCLUSIVE` on the table; the build waits for it, and the observer reads the build's locks
   while it waits;
3. after every file, runs the catalogue checks (foreign keys without an index, RLS state, policies
   that are literally `true`, SECURITY DEFINER functions without `search_path`, unique constraints
   dropped since the base) and the trigger probe (one `UPDATE`, count the audit rows, roll back), so
   each finding is attributed to the first file after which it appears;
4. after the release, reads the migration ledger (`migration_log.schema_migrations`) to say what is
   applied, probes RLS **as `client_role` with one member's claims** (`set local role`, `set_config`
   on `request.jwt.claims`), and applies the release a second time on a copy;
5. writes `REVIEW_REPORT.md`: one row per finding with file, object, severity, impact **measured in
   that run**, fix, and a retest against `release-fixed`; verdict PASS / CONDITIONAL PASS / FAIL.

## What the review found

From the run kept in [`docs/sample-REVIEW_REPORT.md`](docs/sample-REVIEW_REPORT.md) (PostgreSQL
16.15 via `embedded-postgres`, Windows 11, 2026-11-01). Verdict **FAIL**, 8 findings (Critical 1,
High 5, Medium 2). The retest against `release-fixed` found 0 findings, verdict **PASS**.

| # | File | Object | Severity | Impact measured by the review |
| --- | --- | --- | --- | --- |
| 1 | `0002_booking_settings.sql` | `booking_settings` | Medium | applying the release a second time stops at 0002: `relation "booking_settings" already exists` |
| 2 | `0003_audit_trigger.sql` | `appointment_audit_on_change` | High | 1 `UPDATE` on `appointments` wrote 2 audit rows (expected 1) |
| 3 | `0004_assigned_member.sql` | `appointments.assigned_member_id` | Medium | the foreign-key lookup for a `DELETE` on `members` is a Seq Scan over 300 rows |
| 4 | `0005_reminders.sql` | `appointments` | High | table rewritten, then an index built, while holding `AccessExclusiveLock` + `ShareLock`: held 21 ms on 300 rows |
| 5 | `0006_backfill_assignments.sql` | `appointments`, policy `appointment_audit_app_write` | Critical | as a member of one organization, `client_role` reads 150 `appointments` rows and 450 `appointment_audit` rows of the other |
| 6 | `0007_next_slot.sql` | `next_slot(uuid)` | High | runs as `postgres` (superuser) and resolves `appointments`, `booking_settings` through the caller's `search_path` |
| 7 | `0008_member_invites.sql` | `members.members_org_user_unique` | High | a duplicate `(user_id, org_id)` membership was accepted (inserted by the probe, rolled back) |
| 8 | `0009_client_name_required.sql` | `appointments.client_name` | High | 7 of 8 files stayed applied when 0009 failed (`column "client_name" ... contains null values`); since the release cannot be re-run (finding 1), recovery is a hand-written roll-forward or a restore of the pre-release backup |

Milliseconds are from one run on a 300-row table: they are relative and vary between runs.
"Held N ms" (finding 4) is the sum of the timed statements from the one that took the lock to the
end of the file, plus the commit. It excludes the harness's own checkpoint queries, which run while
the transaction is held open, so it understates the wall-clock time the lock was held during the
review. It is a relative measure on a 300-row seed, not a forecast for a production table.

"Runs as `postgres` (superuser)" (finding 6) is read from the server the review runs against (here
the embedded server, where `postgres` is a superuser); it varies by host. On hosted services the
migration role is usually not a superuser (not verified here).

What the fixed release does instead: `CREATE TABLE IF NOT EXISTS` and `DROP POLICY IF EXISTS` before
`CREATE POLICY`; the audit trigger branches on `TG_OP` and has `WHEN (pg_trigger_depth() < 1)`; the
foreign key gets an index built `CONCURRENTLY` first; `reminder_sent_at` has no default and its
index is built `CONCURRENTLY`; the backfill never disables RLS and the new policy checks the
organization; `next_slot()` has `SET search_path = ''` and qualified names; the unique constraint
stays; the `NULL` client names are backfilled before `SET NOT NULL`.

Notes on the planted set, with the PostgreSQL docs ([docs/sources.md](docs/sources.md)):

- **Finding 4 is two mistakes in one transaction.** A plain `CREATE INDEX` takes `SHARE` ("Acquired
  by CREATE INDEX (without CONCURRENTLY)"), which "protects a table against concurrent data
  changes". The `AccessExclusiveLock` comes from the `ADD COLUMN` that precedes it in the same
  file: "An ACCESS EXCLUSIVE lock is acquired unless explicitly noted", and "a lock is normally
  held until the end of the transaction", so the index is built while reads are blocked too. The
  `CONCURRENTLY` build in the fixed release was observed holding only `ShareUpdateExclusiveLock`.
- **The planted default is `clock_timestamp()`, not `now()`.** The docs: with a non-volatile
  default "the default is evaluated at the time of the statement and the result stored in the
  table's metadata" and "In neither case is a rewrite of the table required", while "Adding a
  column with a volatile DEFAULT ... will require the entire table and its indexes to be
  rewritten". On the server used here `now()` is stable and
  `clock_timestamp()` is volatile (read from `pg_proc`), so `DEFAULT now()` would not rewrite the
  table. The harness confirms the rewrite by the changed storage file, not by reading the SQL.
- **The table owner does not normally need to disable RLS for a backfill**: "Table owners normally
  bypass row security as well, though a table owner can choose to be subject to row security with
  ALTER TABLE ... FORCE ROW LEVEL SECURITY." Once disabled, "all rows in the table are visible and
  modifiable, subject to the standard SQL privileges system". Permissive policies "are combined using ... OR", so one
  `USING (true)` policy opens the whole table.
- **SECURITY DEFINER**: the function "is to be executed with the privileges of the user that owns
  it", and "the temporary-table schema ... is searched first by default, and is normally writable
  by anyone".
- **Foreign keys**: "the declaration of a foreign key constraint does not automatically create an
  index on the referencing columns."

## The suite bites: footguns

The suite (`npm test`) asserts literal numbers and object names: 8 findings, each by file and
object; 0 findings and PASS for the fixed release; 2 audit rows vs 1; the locks per statement; 150
and 450 cross-tenant rows vs 0; the partial release state; the re-run failing at 0002. Test (j)
adds one file to the fixed release that leaves the foreign key's index invalid (as a failed
`CREATE INDEX CONCURRENTLY` does) and expects exactly one foreign-key-without-index finding on that
file: an invalid index does not count as covering the key.

Each file in [`footguns/`](footguns/) is a small patch that removes one check from the review.
`npm run footgun <name>` applies it, runs the whole suite, reverts it, and prints `PASS` only when
**exactly** the tests listed in [`footguns/manifest.json`](footguns/manifest.json) fail and every
other test stays green. Measured on 2026-11-01, all seven `PASS`:

| Footgun | What is removed | Tests that fail |
| --- | --- | --- |
| `no-fk-index-check` | the foreign-key-without-index check | (a), (d), (i), (j) |
| `no-rls-check` | the RLS check and its probe as `client_role` | (a), (f), (i) |
| `no-lock-harness` | the `pg_locks` reads from the second connection | (a), (e), (i) |
| `no-trigger-probe` | the one-UPDATE trigger probe | (a), (c), (i) |
| `no-definer-check` | the SECURITY DEFINER `search_path` check | (a), (i) |
| `no-rerun-check` | the second application on a copy | (a), (h), (i) |
| `no-partial-release-report` | reading the ledger after a failure (a failed release is assumed rolled back) | (g) |

Test (i) runs `npm run review -- migrations/release-broken` as a process and asserts the report
holds 8 findings, so every footgun that removes a finding fails it as well as (a). Removing the
ledger read leaves all 8 findings in place; only the reported release state (g) goes wrong, which
is exactly the mistake: a reviewer who assumes the failed release rolled back.

## Run it

Node 22.12 or later is declared in `engines`; exercised locally on Node 24.16. No Docker, no API
key.

```bash
npm ci
npm test                                      # 15 tests: 10 for the review, 5 for the base schema, seed and splitter
npx tsc --noEmit
npm run review -- migrations/release-broken   # writes REVIEW_REPORT.md, exits 1 on FAIL
npm run review -- migrations/release-fixed    # exits 0 on PASS
npm run footgun no-rls-check
```

`npm test` and `npm run review` use `DATABASE_URL` if it is set; otherwise they start PostgreSQL 16
with the [`embedded-postgres`](https://www.npmjs.com/package/embedded-postgres) package in a fresh
directory under the OS temp dir and remove it afterwards. Either way every review creates its own
databases and drops them. The base migration creates the cluster role `client_role` if it does not
exist and does not drop it. Retest: `npm run review -- <dir> --retest <fixed-dir>`; without
`--retest`, a sibling `release-fixed` directory is used when there is one.

The workflow ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs Ubuntu with a `postgres:16`
service container, Windows against the runner's preinstalled PostgreSQL 17, and the seven footguns
on Ubuntu. The first run on GitHub Actions,
[41320825923](https://github.com/guillemustafa-ux/postgres-migration-safety-proof/actions/runs/41320825923),
was green on all nine jobs.

## Safe installation on a managed database

The checklist the review is built from. Each line names the check that covers it here.

1. **Backup point first.** Take one and know how to restore it before applying anything. Not
   verified by this repo: it is a step, not a check.
2. **Review on a copy, never on production.** Run the release against a copy of the schema with
   representative data (`npm run review`), with the same role the release will run as.
3. **Locks.** No write-blocking lock (`SHARE` or stronger) held on a populated table while it is
   scanned, rewritten or indexed. Indexes on existing tables: `CREATE INDEX CONCURRENTLY`, outside a
   transaction (harness, finding 4).
4. **Rewrites.** No volatile default on `ADD COLUMN`; backfill separately (harness, finding 4).
5. **RLS state after the release.** Every tenant table still has RLS enabled, no policy is
   literally `true`, and the app role with real claims sees only its tenant (finding 5).
6. **Functions.** Every SECURITY DEFINER function has `SET search_path = ''` and qualified names;
   decide who may execute it, since "by default, execute privilege is granted to PUBLIC for newly
   created functions" (finding 6).
7. **Triggers.** One write produces one side effect; probe it, do not read it (finding 2).
8. **Constraints.** No unique or primary key dropped without a replacement (finding 7); data
   backfilled before a constraint that depends on it (finding 8); every new foreign key indexed
   (finding 3).
9. **Re-runnable files and a ledger.** Each file can run twice, and the ledger shows exactly what
   is applied, so a release that stops half-way can be rolled forward instead of restored
   (findings 1 and 8).

## Supabase and Replit notes

- **This repo applies to any PostgreSQL 16 the client can reach with a migration role.** It has
  not been run against a hosted Supabase project or a Replit database, and it is never meant to
  run on a client's production database: the review applies a release to scratch databases it
  creates and drops.
- **Supabase roles.** `client_role` stands in for Supabase's `authenticated` ("the role which the
  API (PostgREST) will use when a user is signed in"); migrations run as an owner like `postgres`
  ("The default Postgres role. This has admin privileges."). The claims are set per transaction in
  `request.jwt.claims`; whether that matches how a given PostgREST version passes them is not
  verified here.
- **Supabase on the same mistakes.** "A table in an exposed schema without RLS is readable and
  writable by any role with a grant on it." "Set search_path = '' on every security definer
  function and schema-qualify the names inside it."
- **Replit Publish.** Replit's docs say that at publishing, "any changes you've made with Agent to
  the structure of your development database (adding and deleting columns or tables) are applied
  to your production database". The page does not mention functions or triggers (searched: zero
  occurrences). Whether Publish carries them is **not verified** here; one client reports it does
  not. Either way the procedure above applies: install functions and triggers as reviewed,
  re-runnable files with a ledger. Replit's current databases use "PostgreSQL 16, the same version
  as Neon", the version this review runs by default.

Quotes and URLs: [docs/sources.md](docs/sources.md).

## Limitations, stated plainly

- **Synthetic schema and seed.** Two organizations, 300 appointments, one release of eight files.
- **Measured locally on PostgreSQL 16.15.** The workflow also ran on 16 (Ubuntu) and 17 (Windows),
  green on all nine jobs (see above); other versions are not verified.
- **Lock durations are relative.** They are measured on a 300-row table on one machine; a real
  table makes the same locks last longer. No load is applied while the release runs.
- **No backup or PITR verification.** The backup point is a checklist step; no `pg_dump` or
  restore is exercised.
- **No production run.** Nothing here has touched a managed or production database.
- **The planted set is finite.** A review finds what it checks. The checks are generic catalogue
  queries, but the trigger and RLS probes name this schema's tables (`appointments`,
  `appointment_audit`) and would be adapted to another schema.
- **Some locks are not visible to the observer.** A table created by the file being applied is
  not committed yet, so the second connection cannot name it; only tables that existed before the
  file are listed.
- **No migration framework.** Plain SQL files and a small runner, so the same files apply through
  the Supabase CLI, Replit or `psql`; the runner here is not one of those tools.

## Layout

```text
migrations/0001_base.sql          base schema: organizations, members, appointments, audit; RLS
seed/0001_seed.sql                2 organizations, 8 members, 300 appointments, 300 audit rows
migrations/release-broken/        the release under review, eight planted mistakes
migrations/release-fixed/         the same release corrected
src/runner.ts                     applies .sql files in order, records them in a ledger
src/harness.ts                    per-statement checkpoints, pg_locks from a second connection
src/checks.ts                     catalogue checks and probes
src/review.ts                     the review: attribution per file, release state, re-run, verdict
src/report.ts, src/cli.ts         REVIEW_REPORT.md and `npm run review`
test/review.test.ts               scenarios (a)-(j)
test/base.test.ts                 base schema, seed, RLS as client_role, statement splitter
footguns/                         one patch per removed check + manifest of the tests it must fail
scripts/footgun.mjs               apply, run, revert, strict verdict
docs/sample-REVIEW_REPORT.md      the report from the run quoted above
docs/sources.md                   every third-party claim, quoted with its URL
```

## License

MIT
