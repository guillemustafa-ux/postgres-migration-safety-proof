import { basename, resolve } from 'node:path';
import type pg from 'pg';
import { CATALOGUE_CHECKS, captureBase, type BaseContext, type CheckId, type Issue, type Probes, type Severity } from './checks.js';
import { connect, createScratchDatabase, dropDatabase } from './db.js';
import { applyObserved, type FileRecord, type StatementRecord } from './harness.js';
import { appliedFiles, applyBaseAndSeed, applyDir, listSqlFiles } from './runner.js';
import { label } from './sql.js';

export type { CheckId, Probes, Severity } from './checks.js';
export type { FileRecord, LockObservation, StatementRecord } from './harness.js';

export interface Finding {
  check: CheckId;
  file: string;
  object: string;
  finding: string;
  severity: Severity;
  /** Measured by the review in this run, never typed in. */
  impact: string;
  fix: string;
}

export interface ReleaseState {
  status: 'complete' | 'partial' | 'not-applied';
  applied: string[];
  failed?: { file: string; statement: string; error: string };
  notApplied: string[];
}

export type Verdict = 'PASS' | 'CONDITIONAL PASS' | 'FAIL';

export interface ReviewResult {
  releaseDir: string;
  serverVersion: string;
  files: FileRecord[];
  release: ReleaseState;
  findings: Finding[];
  verdict: Verdict;
  probes: Probes;
}

/** Lock modes that conflict with ROW EXCLUSIVE, i.e. that block INSERT, UPDATE and DELETE. */
const WRITE_BLOCKING = ['ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'];

const HARNESS_CHECKS = {
  'blocking-ddl': {
    severity: 'High' as Severity,
    finding: 'Table-wide work under a write-blocking lock on a populated table: a full rewrite and/or a non-concurrent index build.',
    fix: 'Build indexes with CREATE INDEX CONCURRENTLY outside a transaction; add columns without a volatile default (NULL or a constant) and backfill separately.',
  },
  'release-aborted': {
    severity: 'High' as Severity,
    finding: 'The release stops part-way: one file fails after earlier files were committed.',
    fix: 'Backfill the NULLs before SET NOT NULL, and keep every file re-runnable so a stopped release can be rolled forward.',
  },
  'not-rerunnable': {
    severity: 'Medium' as Severity,
    finding: 'The release cannot be applied twice: applying it again on a copy fails.',
    fix: 'Use IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS and ON CONFLICT so each file can run a second time.',
  },
};

/**
 * Review one release directory on a scratch database: base + seed, then the release file by file
 * under the observing harness, catalogue checks after every file, probes after the release, and a
 * re-run on a copy. Every database it creates is dropped before it returns.
 */
export async function reviewRelease(opts: { serverUrl: string; releaseDir: string }): Promise<ReviewResult> {
  const releaseDir = opts.releaseDir;
  const paths = listSqlFiles(resolve(releaseDir));
  if (paths.length === 0) throw new Error(`no .sql files in ${releaseDir}`);
  const releaseFiles = paths.map((p) => basename(p));

  const db = await createScratchDatabase(opts.serverUrl, 'review');
  const open: pg.Client[] = [];
  const closeAll = async () => {
    for (const c of open.splice(0)) await c.end().catch(() => {});
  };
  try {
    const mig = await connect(db.url);
    const observer = await connect(db.url);
    const blocker = await connect(db.url);
    open.push(mig, observer, blocker);
    const serverVersion: string = (await observer.query('show server_version')).rows[0].server_version;

    await applyBaseAndSeed(mig);
    const base = await captureBase(observer);
    const seen = new Set((await collectIssues(observer, base)).map((i) => i.key));

    const files: FileRecord[] = [];
    const attributed: Array<{ issue: Issue; file: string }> = [];
    for (const path of paths) {
      const record = await applyObserved({ mig, observer, blocker }, path);
      files.push(record);
      for (const issue of await collectIssues(observer, base)) {
        if (seen.has(issue.key)) continue;
        seen.add(issue.key);
        attributed.push({ issue, file: record.file });
      }
      if (!record.ok) break;
    }

    const release = releaseState(await appliedFiles(observer), releaseFiles, files);
    const probes: Probes = {};
    const findings: Finding[] = [];

    for (const check of CATALOGUE_CHECKS) {
      const mine = attributed.filter((a) => a.issue.check === check.id);
      const impact = await check.measure(observer, base, mine.map((a) => a.issue), probes);
      for (const file of [...new Set(mine.map((a) => a.file))]) {
        const objects = mine.filter((a) => a.file === file).map((a) => a.issue.object);
        findings.push({ check: check.id, file, object: objects.join(', '), finding: check.finding, severity: check.severity, impact, fix: check.fix });
      }
    }
    findings.push(...blockingFindings(files, base));

    await closeAll();
    probes.rerun = await rerunOnCopy(opts.serverUrl, db.name, releaseDir);
    if (probes.rerun.status === 'failed') {
      findings.push({
        check: 'not-rerunnable',
        file: probes.rerun.file,
        object: /"([^"]+)"/.exec(probes.rerun.error)?.[1] ?? probes.rerun.file,
        ...HARNESS_CHECKS['not-rerunnable'],
        impact: `Applying the release a second time on a copy stops at ${probes.rerun.file}: ${probes.rerun.error}. A release that stopped half-way cannot be finished by running it again.`,
      });
    }

    const failedFile = files.find((f) => !f.ok);
    if (failedFile) {
      findings.push({
        check: 'release-aborted',
        file: failedFile.file,
        object: failedFile.errorObject ?? label(failedFile.failedStatement ?? ''),
        ...HARNESS_CHECKS['release-aborted'],
        impact: abortedImpact(release, failedFile, probes),
      });
    }

    findings.sort((a, b) => a.file.localeCompare(b.file) || a.check.localeCompare(b.check));
    return { releaseDir, serverVersion, files, release, findings, verdict: verdictOf(findings), probes };
  } finally {
    await closeAll();
    await dropDatabase(opts.serverUrl, db.name);
  }
}

async function collectIssues(db: pg.Client, base: BaseContext): Promise<Issue[]> {
  const out: Issue[] = [];
  for (const check of CATALOGUE_CHECKS) out.push(...(await check.collect(db, base)));
  return out;
}

export function verdictOf(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === 'Critical' || f.severity === 'High')) return 'FAIL';
  return findings.length ? 'CONDITIONAL PASS' : 'PASS';
}

/** What the ledger says was applied, compared with the release's file list. */
function releaseState(ledger: string[], releaseFiles: string[], files: FileRecord[]): ReleaseState {
  const applied = releaseFiles.filter((f) => ledger.includes(f));
  const notApplied = releaseFiles.filter((f) => !ledger.includes(f));
  const failed = files.find((f) => !f.ok);
  return {
    status: notApplied.length === 0 ? 'complete' : applied.length ? 'partial' : 'not-applied',
    applied,
    ...(failed ? { failed: { file: failed.file, statement: label(failed.failedStatement ?? ''), error: failed.error ?? '' } } : {}),
    notApplied,
  };
}

function abortedImpact(release: ReleaseState, failed: FileRecord, probes: Probes): string {
  const total = release.applied.length + release.notApplied.length;
  const applied = release.applied.length
    ? `${release.applied.length} of ${total} files stayed applied (${release.applied[0]} to ${release.applied[release.applied.length - 1]})`
    : `none of the ${total} files stayed applied`;
  const rerun =
    probes.rerun?.status === 'failed'
      ? `The release cannot simply be applied again (a second application stops at ${probes.rerun.file}), so recovery is a hand-written roll-forward of the remaining files or a restore of the pre-release backup.`
      : probes.rerun?.status === 'complete'
        ? 'Every file is re-runnable, so the release can be rolled forward by fixing the failing file and applying the release again.'
        : '';
  return `${applied} when ${failed.file} failed: ${failed.error}. ${rerun}`.trim();
}

/**
 * Lock harness verdict per file and per table that existed after the base and seed: the file
 * rewrote the table or built an index on it while the migration backend HELD a lock that blocks
 * writes (as observed from the second connection). Without an observed lock there is no finding.
 */
function blockingFindings(files: FileRecord[], base: BaseContext): Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    for (const table of base.tables) {
      const events: string[] = [];
      file.statements.forEach((s, i) => {
        const blocking = s.locks.filter((l) => l.table === table && WRITE_BLOCKING.includes(l.mode)).map((l) => l.mode);
        if (!blocking.length) return;
        if (s.rewrote.includes(table)) events.push(`statement ${i + 1} rewrote the table under ${blocking.join(' + ')}`);
        if (s.newIndexes.some((ix) => ix.startsWith(`${table}.`))) events.push(`statement ${i + 1} built an index under ${blocking.join(' + ')}`);
      });
      if (!events.length) continue;
      findings.push({
        check: 'blocking-ddl',
        file: file.file,
        object: table,
        ...HARNESS_CHECKS['blocking-ddl'],
        impact: `${table} (${base.rowCounts[table]} rows): ${events.join('; ')}. ${heldFor(file, table)} Measured on the seeded table: relative, it grows with table size.`,
      });
    }
  }
  return findings;
}

/** How long each write-blocking mode was held on the table: from the statement that took it to commit. */
function heldFor(file: FileRecord, table: string): string {
  const parts: string[] = [];
  for (const mode of WRITE_BLOCKING) {
    const first = file.statements.findIndex((s) => s.locks.some((l) => l.table === table && l.mode === mode));
    if (first === -1) continue;
    const statements: StatementRecord[] = file.mode === 'transaction' ? file.statements.slice(first) : [file.statements[first]];
    const ms = statements.reduce((sum, s) => sum + s.ms, 0) + (file.mode === 'transaction' ? file.commitMs : 0);
    parts.push(`${mode} held ${Math.round(ms * 10) / 10} ms`);
  }
  return parts.length ? `${parts.join(', ')} (${mode(file)}).` : '';
}

function mode(file: FileRecord): string {
  return file.mode === 'transaction' ? 'from the statement that took it until the file committed' : 'for the statement';
}

/** Apply the release a second time on a copy of the reviewed database. */
async function rerunOnCopy(serverUrl: string, sourceDb: string, releaseDir: string): Promise<NonNullable<Probes['rerun']>> {
  const copy = await createScratchDatabase(serverUrl, 'review_rerun', sourceDb);
  const client = await connect(copy.url);
  try {
    const failed = (await applyDir(client, resolve(releaseDir))).find((r) => !r.ok);
    return failed ? { status: 'failed', file: failed.file, error: failed.error ?? '' } : { status: 'complete' };
  } finally {
    await client.end();
    await dropDatabase(serverUrl, copy.name);
  }
}
