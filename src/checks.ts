import type pg from 'pg';

/**
 * Catalogue checks and probes. Each check runs after every release file (so a finding is
 * attributed to the first file after which it appears) and once more after the release to
 * measure the price of what it found. Probes that write run inside a transaction that is rolled
 * back, so they never change what the next file sees.
 */

export type CheckId =
  | 'trigger-side-effect'
  | 'fk-without-index'
  | 'blocking-ddl'
  | 'rls-off'
  | 'definer-search-path'
  | 'unique-dropped'
  | 'release-aborted'
  | 'not-rerunnable';

export type Severity = 'Critical' | 'High' | 'Medium';

export interface Issue {
  check: CheckId;
  key: string;
  object: string;
}

export interface Probes {
  trigger?: { table: string; auditTable: string; auditRowsPerUpdate: number };
  rls?: { user: string; org: string; tables: Record<string, { visible: number; otherOrg: number }> };
  rerun?: { status: 'complete' } | { status: 'failed'; file: string; error: string };
}

/** State captured after the base schema and seed, before the release. */
export interface BaseContext {
  tables: string[];
  rowCounts: Record<string, number>;
  uniqueKeys: Array<{ table: string; name: string; columns: string[] }>;
  forcedRls: string[];
}

export interface Check {
  id: CheckId;
  severity: Severity;
  finding: string;
  fix: string;
  collect(db: pg.Client, base: BaseContext): Promise<Issue[]>;
  /** After the release: fill the probe results and return the measured impact of the issues. */
  measure(db: pg.Client, base: BaseContext, issues: Issue[], probes: Probes): Promise<string>;
}

export async function captureBase(db: pg.Client): Promise<BaseContext> {
  const tables = (
    await db.query<{ relname: string; forced: boolean }>(
      `select relname, relforcerowsecurity as forced from pg_class
       where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by relname`,
    )
  ).rows;
  const rowCounts: Record<string, number> = {};
  for (const t of tables) rowCounts[t.relname] = await countRows(db, t.relname);
  const uniqueKeys = (
    await db.query<{ table: string; name: string; columns: string[] }>(`
      select c.conrelid::regclass::text as table, c.conname as name,
             array_agg(a.attname::text order by k.ord) as columns
      from pg_constraint c
      cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.connamespace = 'public'::regnamespace and c.contype in ('u', 'p')
      group by c.oid, c.conrelid, c.conname
      order by 1, 2`)
  ).rows;
  return { tables: tables.map((t) => t.relname), rowCounts, uniqueKeys, forcedRls: tables.filter((t) => t.forced).map((t) => t.relname) };
}

export async function countRows(db: pg.Client, table: string): Promise<number> {
  return (await db.query<{ n: number }>(`select count(*)::int as n from public.${quoteIdent(table)}`)).rows[0].n;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function rolledBack<T>(db: pg.Client, fn: () => Promise<T>): Promise<T> {
  await db.query('begin');
  try {
    return await fn();
  } finally {
    await db.query('rollback');
  }
}

// ---------------------------------------------------------------------------------------------
// (1) Trigger side-effect probe: one UPDATE on one appointment must write exactly one audit row.

const PROBE_TABLE = 'appointments';
const AUDIT_TABLE = 'appointment_audit';

async function auditRowsForOneUpdate(db: pg.Client): Promise<number> {
  return rolledBack(db, async () => {
    const id = (await db.query(`select min(id) as id from public.appointments`)).rows[0].id;
    const count = async () =>
      (await db.query<{ n: number }>(`select count(*)::int as n from public.appointment_audit where appointment_id = $1`, [id])).rows[0].n;
    const before = await count();
    await db.query(`update public.appointments set status = 'confirmed' where id = $1`, [id]);
    return (await count()) - before;
  });
}

export const triggerProbe: Check = {
  id: 'trigger-side-effect',
  severity: 'High',
  finding: 'Duplicated side effect: one UPDATE on appointments writes more than one audit row (the triggers on appointments and appointment_audit feed each other).',
  fix: 'Branch on TG_OP and add WHEN (pg_trigger_depth() < 1) to the audit trigger, so the UPDATE issued by another trigger is not audited again.',
  async collect(db) {
    if ((await auditRowsForOneUpdate(db)) <= 1) return [];
    const triggers = (
      await db.query<{ tgname: string }>(
        `select tgname from pg_trigger where tgrelid = 'public.appointments'::regclass and not tgisinternal order by tgname`,
      )
    ).rows.map((r) => r.tgname);
    return [{ check: this.id, key: 'trigger-dup:appointments', object: triggers.join(', ') }];
  },
  async measure(db, _base, _issues, probes) {
    const n = await auditRowsForOneUpdate(db);
    probes.trigger = { table: PROBE_TABLE, auditTable: AUDIT_TABLE, auditRowsPerUpdate: n };
    return `1 UPDATE on ${PROBE_TABLE} wrote ${n} rows in ${AUDIT_TABLE} (expected 1): ${n - 1} duplicated audit row(s) per updated appointment.`;
  },
};

// ---------------------------------------------------------------------------------------------
// (2) Foreign keys whose referencing columns are not the leading columns of any index.

export const fkIndexCheck: Check = {
  id: 'fk-without-index',
  severity: 'Medium',
  finding: 'Foreign key without an index on the referencing column.',
  fix: 'CREATE INDEX CONCURRENTLY on the referencing column (outside a transaction) before adding the foreign key.',
  async collect(db) {
    const { rows } = await db.query<{ table: string; cols: string }>(`
      select c.conrelid::regclass::text as table, string_agg(a.attname::text, ',' order by k.ord) as cols
      from pg_constraint c
      cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
        and not exists (
          select 1 from pg_index i
          where i.indrelid = c.conrelid and i.indpred is null
            and (i.indkey::int2[])[0:cardinality(c.conkey) - 1] @> c.conkey)
      group by c.oid, c.conrelid
      order by 1, 2`);
    return rows.map((r) => ({ check: this.id, key: `fk:${r.table}.${r.cols}`, object: `${r.table}.${r.cols}` }));
  },
  async measure(db, _base, issues) {
    const parts: string[] = [];
    for (const issue of issues) {
      const [table, cols] = issue.object.split('.');
      const ref = (
        await db.query<{ ref: string }>(
          `select confrelid::regclass::text as ref from pg_constraint
           where contype = 'f' and conrelid = $1::regclass
             and conkey = (select array_agg(attnum order by ord) from unnest($2::text[]) with ordinality as u(name, ord)
                           join pg_attribute on attrelid = $1::regclass and attname = u.name)`,
          [`public.${table}`, cols.split(',')],
        )
      ).rows[0]?.ref;
      // The lookup Postgres runs for every DELETE or key UPDATE on the referenced table.
      const where = cols.split(',').map((c, i) => `${quoteIdent(c)} = $${i + 1}`).join(' and ');
      const plan = (
        await db.query(`explain (format json, generic_plan) select 1 from only public.${quoteIdent(table)} x where ${where} for key share of x`)
      ).rows[0]['QUERY PLAN'][0].Plan;
      const scan = findScan(plan, table) ?? 'unknown';
      parts.push(
        `Every DELETE or key UPDATE on ${ref ?? 'the referenced table'} looks up ${issue.object} with a ${scan} over ${await countRows(db, table)} rows (EXPLAIN of the foreign-key lookup).`,
      );
    }
    return parts.join(' ');
  },
};

function findScan(plan: { 'Node Type': string; 'Relation Name'?: string; Plans?: unknown[] }, table: string): string | undefined {
  if (plan['Relation Name'] === table) return plan['Node Type'];
  for (const child of (plan.Plans ?? []) as Array<typeof plan>) {
    const found = findScan(child, table);
    if (found) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// (4) RLS: tables with RLS disabled (or FORCE turned off since the base), policies that are `true`.

/** How the probe tells which organization a visible row belongs to. */
const TENANT_ROWS: Record<string, string> = {
  appointments: `select a.id, a.org_id from public.appointments a`,
  appointment_audit: `select au.id, ap.org_id from public.appointment_audit au join public.appointments ap on ap.id = au.appointment_id`,
};

async function rlsProbe(db: pg.Client): Promise<NonNullable<Probes['rls']>> {
  const member = (await db.query<{ user: string; org: string }>(`select user_id::text as user, org_id::text as org from public.members order by id limit 1`))
    .rows[0];
  const visible = await rolledBack(db, async () => {
    // Same switch as a PostgREST/Supabase request: the app role plus the caller's claims.
    await db.query('set local role client_role');
    await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: member.user, role: 'authenticated' })]);
    const ids: Record<string, string[]> = {};
    for (const table of Object.keys(TENANT_ROWS)) {
      ids[table] = (await db.query<{ id: string }>(`select id::text as id from public.${table}`)).rows.map((r) => r.id);
    }
    return ids;
  });
  const tables: Record<string, { visible: number; otherOrg: number }> = {};
  for (const [table, rows] of Object.entries(TENANT_ROWS)) {
    const { other } = (
      await db.query<{ other: number }>(`select count(*)::int as other from (${rows}) t where t.id::text = any($1) and t.org_id::text <> $2`, [
        visible[table],
        member.org,
      ])
    ).rows[0];
    tables[table] = { visible: visible[table].length, otherOrg: other };
  }
  return { user: member.user, org: member.org, tables };
}

export const rlsCheck: Check = {
  id: 'rls-off',
  severity: 'Critical',
  finding: 'Tenant isolation removed: row level security disabled on a tenant table and/or a policy whose USING or WITH CHECK is literally true.',
  fix: 'Do not disable RLS for a backfill (the owner role normally bypasses it anyway); scope every policy by organization; re-assert ENABLE ROW LEVEL SECURITY at the end of the release.',
  async collect(db, base) {
    const issues: Issue[] = [];
    const tables = (
      await db.query<{ relname: string; enabled: boolean; forced: boolean }>(
        `select relname, relrowsecurity as enabled, relforcerowsecurity as forced from pg_class
         where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by relname`,
      )
    ).rows;
    for (const t of tables) {
      if (!t.enabled) issues.push({ check: this.id, key: `rls-off:${t.relname}`, object: t.relname });
      else if (base.forcedRls.includes(t.relname) && !t.forced) issues.push({ check: this.id, key: `rls-unforced:${t.relname}`, object: t.relname });
    }
    const policies = (
      await db.query<{ tablename: string; policyname: string }>(
        `select tablename, policyname from pg_policies
         where schemaname = 'public' and (qual = 'true' or with_check = 'true') order by 1, 2`,
      )
    ).rows;
    for (const p of policies) {
      issues.push({ check: this.id, key: `policy-true:${p.tablename}.${p.policyname}`, object: `${p.tablename}.${p.policyname}` });
    }
    return issues;
  },
  async measure(db, _base, _issues, probes) {
    const probe = await rlsProbe(db);
    probes.rls = probe;
    const exposed = Object.entries(probe.tables).map(([t, v]) => `${v.otherOrg} rows of other organizations in ${t}`);
    return `client_role with the claims of a member of one organization reads ${exposed.join(' and ')}.`;
  },
};

// ---------------------------------------------------------------------------------------------
// (5) SECURITY DEFINER functions without a pinned search_path.

export const definerCheck: Check = {
  id: 'definer-search-path',
  severity: 'High',
  finding: 'SECURITY DEFINER function without SET search_path: names inside it resolve through the caller\'s search_path.',
  fix: "Add SET search_path = '' to the function and schema-qualify every name in its body.",
  async collect(db) {
    const { rows } = await db.query<{ fn: string }>(`
      select p.oid::regprocedure::text as fn from pg_proc p
      where p.pronamespace = 'public'::regnamespace and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) as cfg where cfg like 'search_path=%')
      order by 1`);
    return rows.map((r) => ({ check: this.id, key: `definer:${r.fn}`, object: r.fn }));
  },
  async measure(db, _base, issues) {
    const parts: string[] = [];
    const tables = (
      await db.query<{ relname: string }>(
        `select relname from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') order by 1`,
      )
    ).rows.map((r) => r.relname);
    for (const issue of issues) {
      const { owner, superuser, src } = (
        await db.query<{ owner: string; superuser: boolean; src: string }>(
          `select r.rolname as owner, r.rolsuper as superuser, p.prosrc as src
           from pg_proc p join pg_roles r on r.oid = p.proowner where p.oid = $1::regprocedure`,
          [`public.${issue.object}`],
        )
      ).rows[0];
      const unqualified = tables.filter((t) => new RegExp(`(?<![\\w."])${t}\\b`).test(src));
      parts.push(
        `${issue.object} runs as ${owner} (superuser: ${superuser ? 'yes' : 'no'}) and resolves the unqualified table name(s) ${unqualified.join(', ') || '(none found)'} through the caller's search_path.`,
      );
    }
    return parts.join(' ');
  },
};

// ---------------------------------------------------------------------------------------------
// (7) Unique or primary-key constraints present in the base and gone after the release.

export const uniqueCheck: Check = {
  id: 'unique-dropped',
  severity: 'High',
  finding: 'Unique constraint dropped and not replaced.',
  fix: 'Keep the unique constraint; handle the new case (a re-invite) by updating the existing row.',
  async collect(db, base) {
    const present = new Set(
      (
        await db.query<{ key: string }>(
          `select conrelid::regclass::text || '.' || conname as key from pg_constraint
           where connamespace = 'public'::regnamespace and contype in ('u', 'p')`,
        )
      ).rows.map((r) => r.key),
    );
    return base.uniqueKeys
      .filter((k) => !present.has(`${k.table}.${k.name}`))
      .map((k) => ({ check: this.id, key: `unique:${k.table}.${k.name}`, object: `${k.table}.${k.name}` }));
  },
  async measure(db, base, issues) {
    const parts: string[] = [];
    for (const issue of issues) {
      const key = base.uniqueKeys.find((k) => `${k.table}.${k.name}` === issue.object);
      if (!key) continue;
      const accepted = await rolledBack(db, async () => {
        const cols = (
          await db.query<{ name: string }>(
            `select attname::text as name from pg_attribute
             where attrelid = $1::regclass and attnum > 0 and not attisdropped and attidentity = '' and attgenerated = ''
             order by attnum`,
            [`public.${key.table}`],
          )
        ).rows.map((r) => quoteIdent(r.name));
        const list = cols.join(', ');
        const inserted = await db.query(`insert into public.${quoteIdent(key.table)} (${list}) select ${list} from public.${quoteIdent(key.table)} limit 1`);
        return inserted.rowCount ?? 0;
      });
      parts.push(
        `A second ${key.table} row with the same (${key.columns.join(', ')}) was accepted: ${accepted} duplicate inserted by the probe, then rolled back.`,
      );
    }
    return parts.join(' ');
  },
};

/** The checks that run after every file. The lock harness, the release state and the re-run check live in review.ts. */
export const CATALOGUE_CHECKS: Check[] = [triggerProbe, fkIndexCheck, rlsCheck, definerCheck, uniqueCheck];
