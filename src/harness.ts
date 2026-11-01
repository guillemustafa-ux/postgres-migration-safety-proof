import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import type pg from 'pg';
import { applyFile, round } from './runner.js';
import { label, stripComments } from './sql.js';

/**
 * Applies one release file through the runner and records, per statement, what it did to the
 * tables that already existed: which locks the migration backend held (read from `pg_locks` by a
 * SECOND connection while the statement's transaction is held open at a checkpoint), whether a
 * table was rewritten (`pg_relation_filenode` changed) and which indexes appeared.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction, so there is no checkpoint to hold.
 * Instead a third connection holds ROW EXCLUSIVE on the table; the concurrent build waits for it
 * (it waits for existing writers before building), and while it waits the observer reads the
 * locks it holds. Then the third connection commits and the build finishes.
 */

export interface LockObservation {
  table: string;
  mode: string;
}

export interface StatementRecord {
  label: string;
  ms: number;
  /** Relation locks on tables of schema public held by the migration backend at the checkpoint. */
  locks: LockObservation[];
  /** Tables whose storage file changed in this statement (a full rewrite). */
  rewrote: string[];
  /** Indexes that appeared on tables that existed before the statement, as `table.index`. */
  newIndexes: string[];
}

export interface FileRecord {
  file: string;
  mode: 'transaction' | 'per-statement';
  ok: boolean;
  statements: StatementRecord[];
  commitMs: number;
  failedStatement?: string;
  error?: string;
  errorObject?: string;
}

export interface Connections {
  mig: pg.Client;
  observer: pg.Client;
  blocker: pg.Client;
}

type Snapshot = Map<string, { filenode: string; indexes: string[] }>;

export async function snapshotTables(client: pg.Client): Promise<Snapshot> {
  const { rows } = await client.query<{ table: string; filenode: string; indexes: string[] }>(`
    select c.relname as table,
           pg_relation_filenode(c.oid)::text as filenode,
           coalesce((select array_agg(ic.relname::text order by ic.relname)
                     from pg_index i join pg_class ic on ic.oid = i.indexrelid
                     where i.indrelid = c.oid), '{}') as indexes
    from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')`);
  return new Map(rows.map((r) => [r.table, { filenode: r.filenode, indexes: r.indexes }]));
}

export async function observeLocks(observer: pg.Client, pid: number): Promise<LockObservation[]> {
  const { rows } = await observer.query<LockObservation>(
    `select distinct c.relname as table, l.mode
     from pg_locks l join pg_class c on c.oid = l.relation
     where l.pid = $1 and l.granted and l.locktype = 'relation'
       and c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
     order by 1, 2`,
    [pid],
  );
  return rows;
}

function diff(before: Snapshot, after: Snapshot): Pick<StatementRecord, 'rewrote' | 'newIndexes'> {
  const rewrote: string[] = [];
  const newIndexes: string[] = [];
  for (const [table, now] of after) {
    const was = before.get(table);
    if (!was) continue;
    if (was.filenode !== now.filenode) rewrote.push(table);
    for (const index of now.indexes) if (!was.indexes.includes(index)) newIndexes.push(`${table}.${index}`);
  }
  return { rewrote, newIndexes };
}

export async function applyObserved(conns: Connections, path: string): Promise<FileRecord> {
  const { mig, observer, blocker } = conns;
  const pid: number = (await mig.query('select pg_backend_pid() as pid')).rows[0].pid;
  let before = await snapshotTables(mig);
  const observed: Array<Omit<StatementRecord, 'label' | 'ms'>> = [];

  const result = await applyFile(mig, path, {
    async checkpoint(index) {
      // The statement's transaction is still open: its locks are still held.
      const locks = await observeLocks(observer, pid);
      const after = await snapshotTables(mig);
      observed[index] = { locks, ...diff(before, after) };
      before = after;
    },
    async runAutocommit(index, sql, run) {
      const table = /\bon\s+(?:only\s+)?([\w."]+)/i.exec(stripComments(sql))?.[1];
      let locks: LockObservation[] = [];
      let ms: number;
      if (table) {
        await blocker.query('begin');
        await blocker.query(`lock table ${table} in row exclusive mode`);
        const pending = run().then(
          () => undefined,
          (error: unknown) => error,
        );
        for (let i = 0; i < 200; i++) {
          const { rows } = await observer.query(`select wait_event_type from pg_stat_activity where pid = $1`, [pid]);
          if (rows[0]?.wait_event_type === 'Lock') break;
          await sleep(25);
        }
        locks = await observeLocks(observer, pid);
        const start = performance.now();
        await blocker.query('commit');
        const error = await pending;
        ms = round(performance.now() - start);
        if (error) throw error;
      } else {
        const start = performance.now();
        await run();
        ms = round(performance.now() - start);
      }
      const after = await snapshotTables(mig);
      observed[index] = { locks, ...diff(before, after) };
      before = after;
      return ms;
    },
  });

  return {
    file: result.file,
    mode: result.mode,
    ok: result.ok,
    commitMs: result.commitMs,
    statements: result.statements.map((s, i) => ({
      label: label(s.sql),
      ms: s.ms,
      ...(observed[i] ?? { locks: [], rewrote: [], newIndexes: [] }),
    })),
    failedStatement: result.failedStatement,
    error: result.error,
    errorObject: result.errorObject,
  };
}
