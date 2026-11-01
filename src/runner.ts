import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { needsAutocommit, splitStatements } from './sql.js';

/**
 * A tiny migration runner: plain `.sql` files applied in name order.
 *  - A file runs in ONE transaction, unless it contains a statement Postgres refuses inside a
 *    transaction block (`... CONCURRENTLY`); then each statement runs in its own transaction.
 *  - Every applied file is recorded in `migration_log.schema_migrations`, in the same transaction
 *    as the file when there is one. The ledger is what tells a half-applied release apart.
 *  - It stops at the first failing file. It does not skip files already in the ledger: applying a
 *    release twice is exactly what the re-run check needs to do.
 */

export interface StatementRun {
  sql: string;
  ms: number;
}

export interface FileResult {
  file: string;
  mode: 'transaction' | 'per-statement';
  statements: StatementRun[];
  ok: boolean;
  failedStatement?: string;
  error?: string;
  /** What the error is about: `table.column` / `table` from the server's error fields, else the first quoted name. */
  errorObject?: string;
  commitMs: number;
}

export interface RunnerHooks {
  /** Called after each statement while its transaction is still open (the harness checkpoint). */
  checkpoint?(index: number, statement: string): Promise<void>;
  /** Runs a statement that needs autocommit (CONCURRENTLY); returns the ms to record. */
  runAutocommit?(index: number, statement: string, run: () => Promise<void>): Promise<number>;
}

export async function ensureLedger(client: pg.Client): Promise<void> {
  await client.query(`create schema if not exists migration_log`);
  await client.query(
    `create table if not exists migration_log.schema_migrations (name text primary key, applied_at timestamptz not null default now())`,
  );
}

export async function appliedFiles(client: pg.Client): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(`select name from migration_log.schema_migrations order by name`);
  return rows.map((r) => r.name);
}

export function listSqlFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => join(dir, f));
}

export async function applyFile(client: pg.Client, path: string, hooks: RunnerHooks = {}): Promise<FileResult> {
  const file = basename(path);
  const statements = splitStatements(readFileSync(path, 'utf8'));
  const perStatement = statements.some(needsAutocommit);
  const result: FileResult = { file, mode: perStatement ? 'per-statement' : 'transaction', statements: [], ok: false, commitMs: 0 };
  const record = `insert into migration_log.schema_migrations (name) values ($1) on conflict do nothing`;
  let current = '';
  let inTransaction = false;
  try {
    if (!perStatement) {
      await client.query('begin');
      inTransaction = true;
    }
    for (const [index, sql] of statements.entries()) {
      current = sql;
      if (perStatement && needsAutocommit(sql)) {
        const run = async () => {
          await client.query(sql);
        };
        const ms = hooks.runAutocommit ? await hooks.runAutocommit(index, sql, run) : await timed(run);
        result.statements.push({ sql, ms });
        continue;
      }
      if (perStatement) {
        await client.query('begin');
        inTransaction = true;
      }
      const ms = await timed(() => client.query(sql));
      result.statements.push({ sql, ms });
      await hooks.checkpoint?.(index, sql);
      if (perStatement) {
        result.commitMs += await timed(() => client.query('commit'));
        inTransaction = false;
      }
    }
    current = '';
    if (inTransaction) {
      await client.query(record, [file]);
      result.commitMs += await timed(() => client.query('commit'));
      inTransaction = false;
    } else {
      await client.query(record, [file]);
    }
    result.ok = true;
  } catch (error) {
    if (inTransaction) await client.query('rollback');
    result.failedStatement = current;
    result.error = error instanceof Error ? error.message : String(error);
    const fields = error as { table?: string; column?: string };
    result.errorObject = fields.table
      ? [fields.table, fields.column].filter(Boolean).join('.')
      : /"([^"]+)"/.exec(result.error)?.[1];
  }
  return result;
}

export const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Base schema (top-level files of `migrations/`) and seed data, as one starting point for every review. */
export async function applyBaseAndSeed(client: pg.Client): Promise<FileResult[]> {
  const results = [...(await applyDir(client, join(REPO_ROOT, 'migrations'))), ...(await applyDir(client, join(REPO_ROOT, 'seed')))];
  const failed = results.find((r) => !r.ok);
  if (failed) throw new Error(`base/seed failed in ${failed.file}: ${failed.error}`);
  return results;
}

/** Apply every `.sql` file of a directory in order; stop at the first failure. */
export async function applyDir(client: pg.Client, dir: string, hooks?: RunnerHooks): Promise<FileResult[]> {
  await ensureLedger(client);
  const results: FileResult[] = [];
  for (const path of listSqlFiles(dir)) {
    const result = await applyFile(client, path, hooks);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const start = performance.now();
  await fn();
  return round(performance.now() - start);
}

export function round(ms: number): number {
  return Math.round(ms * 10) / 10;
}
