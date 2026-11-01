# Sources

Every statement in the README about PostgreSQL, Supabase or Replit comes from one of these pages,
fetched on 2026-11-01. Each quote below was checked word for word against a downloaded copy of the
page (HTML tags and code formatting removed before comparing). Where a statement is about what a
page does *not* say, the method is stated.

## PostgreSQL 16

**Explicit locking**: <https://www.postgresql.org/docs/16/explicit-locking.html>

- SHARE: "This mode protects a table against concurrent data changes." / "Acquired by CREATE INDEX
  (without CONCURRENTLY)."
- SHARE UPDATE EXCLUSIVE: "Acquired by VACUUM (without FULL), ANALYZE, CREATE INDEX CONCURRENTLY,
  ..."
- ROW EXCLUSIVE: "Conflicts with the SHARE, SHARE ROW EXCLUSIVE, EXCLUSIVE, and ACCESS EXCLUSIVE
  lock modes."
- ACCESS EXCLUSIVE: "Many forms of ALTER INDEX and ALTER TABLE also acquire a lock at this level."
- "Once acquired, a lock is normally held until the end of the transaction."
- "To examine a list of the currently outstanding locks in a database server, use the pg_locks
  system view."

**CREATE INDEX**: <https://www.postgresql.org/docs/16/sql-createindex.html>

- "When this option is used, PostgreSQL will build the index without taking any locks that prevent
  concurrent inserts, updates, or deletes on the table; whereas a standard index build locks out
  writes (but not reads) on the table until it's done."
- "... it must wait for all existing transactions that could potentially modify or use the index
  to terminate."
- "Another difference is that a regular CREATE INDEX command can be performed within a transaction
  block, but CREATE INDEX CONCURRENTLY cannot."
- On a failed concurrent build: "... the CREATE INDEX command will fail but leave behind an
  “invalid” index."

**ALTER TABLE**: <https://www.postgresql.org/docs/16/sql-altertable.html>

- "When a column is added with ADD COLUMN and a non-volatile DEFAULT is specified, the default is
  evaluated at the time of the statement and the result stored in the table's metadata." ... "In
  neither case is a rewrite of the table required."
- "Adding a column with a volatile DEFAULT or changing the type of an existing column will require
  the entire table and its indexes to be rewritten."
- On SET NOT NULL: "Ordinarily this is checked during the ALTER TABLE by scanning the entire
  table; ..."
- "An ACCESS EXCLUSIVE lock is acquired unless explicitly noted."
- "ADD FOREIGN KEY requires only a SHARE ROW EXCLUSIVE lock."

**Date/time functions**: <https://www.postgresql.org/docs/16/functions-datetime.html>

- "now() is a traditional PostgreSQL equivalent to transaction_timestamp()."
- "Since these functions return the start time of the current transaction, their values do not
  change during the transaction."
- clock_timestamp() "returns the actual current time, and therefore its value changes even within
  a single SQL statement."
- Not from the docs: the volatility class was read from the catalogue of the PostgreSQL 16.15
  server used to build this repo: `select proname, provolatile from pg_proc where proname in
  ('now', 'clock_timestamp')` returned `s` (stable) for `now` and `v` (volatile) for
  `clock_timestamp`.

**CREATE FUNCTION**: <https://www.postgresql.org/docs/16/sql-createfunction.html>

- "SECURITY DEFINER specifies that the function is to be executed with the privileges of the user
  that owns it."
- From "Writing SECURITY DEFINER Functions Safely": "For security, search_path should be set to
  exclude any schemas writable by untrusted users." / "Particularly important in this regard is
  the temporary-table schema, which is searched first by default, and is normally writable by
  anyone." / about the example function: "... the function could be subverted by creating a
  temporary table named pwds."
- "... by default, execute privilege is granted to PUBLIC for newly created functions ..."

**Row security policies**: <https://www.postgresql.org/docs/16/ddl-rowsecurity.html>

- "If no policy exists for the table, a default-deny policy is used, meaning that no rows are
  visible or can be modified."
- "Table owners normally bypass row security as well, though a table owner can choose to be
  subject to row security with ALTER TABLE ... FORCE ROW LEVEL SECURITY."
- Policies "are combined using either OR (for permissive policies, which are the default) or using
  AND (for restrictive policies)."
- "Disabling row security does not remove any policies that are defined on the table; they are
  simply ignored. Then all rows in the table are visible and modifiable, subject to the standard
  SQL privileges system."

**Constraints, foreign keys**: <https://www.postgresql.org/docs/16/ddl-constraints.html>

- "Since a DELETE of a row from the referenced table or an UPDATE of a referenced column will
  require a scan of the referencing table for rows matching the old value, it is often a good idea
  to index the referencing columns too."
- "... the declaration of a foreign key constraint does not automatically create an index on the
  referencing columns."

**System information functions**: <https://www.postgresql.org/docs/16/functions-info.html>

- pg_trigger_depth(): "Returns the current nesting level of PostgreSQL triggers (0 if not called,
  directly or indirectly, from inside a trigger)."

## Supabase

**Postgres Roles**: <https://supabase.com/docs/guides/database/postgres/roles>

- `postgres`: "The default Postgres role. This has admin privileges."
- `authenticated`: "This is the role which the API (PostgREST) will use when a user is signed in."
- `service_role`: "This role is used by the API (PostgREST) to bypass Row Level Security."

**Row Level Security**: <https://supabase.com/docs/guides/database/postgres/row-level-security>

- "A table in an exposed schema without RLS is readable and writable by any role with a grant on
  it."
- "Set search_path = '' on every security definer function and schema-qualify the names inside
  it."
- "A security definer function in an exposed schema is callable over the Data API with the
  creator's privileges."

## Replit

**Development and production databases**:
<https://docs.replit.com/features/data-and-storage/development-and-production.md>

- "At the time of publishing, any changes you've made with Agent to the structure of your
  development database (adding and deleting columns or tables) are applied to your production
  database."
- "Database changes sometimes require stopping your app temporarily to prevent conflicts and
  protect your data while the changes are applied."
- "Helium uses PostgreSQL 16, the same version as Neon."
- Method for what the page does not say: the page (12,180 bytes of Markdown) was searched
  case-insensitively for `trigger` and `function`: zero occurrences. It does not say whether
  publishing carries functions or triggers to production. This repo does not verify that either
  way; the claim that Publish "does not transfer functions or triggers" comes from a client's job
  post, not from Replit.
- `https://docs.replit.com/cloud-services/storage-and-databases/sql-database` ("Database") was also
  read; it does not mention publishing.
