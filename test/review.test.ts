import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, inject, test } from 'vitest';
import { reviewRelease, type CheckId, type ReviewResult, type StatementRecord } from '../src/review.js';

const BROKEN = 'migrations/release-broken';
const FIXED = 'migrations/release-fixed';

const RELEASE_FILES = [
  '0002_booking_settings.sql',
  '0003_audit_trigger.sql',
  '0004_assigned_member.sql',
  '0005_reminders.sql',
  '0006_backfill_assignments.sql',
  '0007_next_slot.sql',
  '0008_member_invites.sql',
  '0009_client_name_required.sql',
];

describe('review of the broken release and of the fixed release', () => {
  const serverUrl = inject('serverUrl');
  let broken: ReviewResult;
  let fixed: ReviewResult;

  beforeAll(async () => {
    broken = await reviewRelease({ serverUrl, releaseDir: BROKEN });
    fixed = await reviewRelease({ serverUrl, releaseDir: FIXED });
  });

  const only = (result: ReviewResult, check: CheckId) => {
    const found = result.findings.filter((f) => f.check === check);
    expect(found, `${check} findings`).toHaveLength(1);
    return found[0];
  };

  test('(a) the broken release yields exactly the 8 planted findings, each named by file and object', () => {
    expect(broken.findings).toHaveLength(8);
    // (8) not re-runnable
    expect(only(broken, 'not-rerunnable')).toMatchObject({ file: '0002_booking_settings.sql', object: 'booking_settings', severity: 'Medium' });
    // (1) trigger recursion: one UPDATE, two audit rows
    expect(only(broken, 'trigger-side-effect')).toMatchObject({ file: '0003_audit_trigger.sql', object: 'appointment_audit_on_change', severity: 'High' });
    // (2) foreign key without an index on the referencing column
    expect(only(broken, 'fk-without-index')).toMatchObject({ file: '0004_assigned_member.sql', object: 'appointments.assigned_member_id', severity: 'Medium' });
    // (3) index build and table rewrite under write-blocking locks
    expect(only(broken, 'blocking-ddl')).toMatchObject({ file: '0005_reminders.sql', object: 'appointments', severity: 'High' });
    // (4) RLS switched off and a policy that is literally true
    expect(only(broken, 'rls-off')).toMatchObject({
      file: '0006_backfill_assignments.sql',
      object: 'appointments, appointment_audit.appointment_audit_app_write',
      severity: 'Critical',
    });
    // (5) SECURITY DEFINER without search_path
    expect(only(broken, 'definer-search-path')).toMatchObject({ file: '0007_next_slot.sql', object: 'next_slot(uuid)', severity: 'High' });
    // (7) unique constraint dropped
    expect(only(broken, 'unique-dropped')).toMatchObject({ file: '0008_member_invites.sql', object: 'members.members_org_user_unique', severity: 'High' });
    // (6) release aborted mid-way
    expect(only(broken, 'release-aborted')).toMatchObject({ file: '0009_client_name_required.sql', object: 'appointments.client_name', severity: 'High' });
    expect(broken.verdict).toBe('FAIL');
  });

  test('(b) the fixed release yields 0 findings and PASS', () => {
    expect(fixed.findings).toEqual([]);
    expect(fixed.verdict).toBe('PASS');
  });

  test('(c) trigger probe: 1 UPDATE writes 2 audit rows on broken, 1 on fixed', () => {
    expect(broken.probes.trigger).toEqual({ table: 'appointments', auditTable: 'appointment_audit', auditRowsPerUpdate: 2 });
    expect(fixed.probes.trigger).toEqual({ table: 'appointments', auditTable: 'appointment_audit', auditRowsPerUpdate: 1 });
  });

  test('(d) FK-without-index names appointments.assigned_member_id on broken and nothing on fixed', () => {
    expect(broken.findings.filter((f) => f.check === 'fk-without-index').map((f) => f.object)).toEqual(['appointments.assigned_member_id']);
    expect(fixed.findings.filter((f) => f.check === 'fk-without-index')).toEqual([]);
  });

  test('(e) lock harness: AccessExclusiveLock on appointments during the broken CREATE INDEX, not during the fixed CONCURRENTLY build', () => {
    const modes = (s: StatementRecord | undefined) =>
      (s?.locks ?? []).filter((l) => l.table === 'appointments').map((l) => l.mode).sort();
    const brokenFile = broken.files.find((f) => f.file === '0005_reminders.sql');
    const brokenAlter = brokenFile?.statements.find((s) => s.label.startsWith('alter table public.appointments add column reminder_sent_at'));
    const brokenIndex = brokenFile?.statements.find((s) => s.label.startsWith('create index appointments_starts_at_idx'));
    // The ADD COLUMN with a volatile default rewrites the table (relfilenode changes); at its
    // checkpoint the backend holds AccessExclusiveLock and ShareLock on appointments (measured; per
    // the ALTER TABLE docs the table AND its indexes are rewritten). The same transaction then
    // builds the new index while still holding both.
    expect(brokenAlter?.rewrote).toEqual(['appointments']);
    expect(modes(brokenAlter)).toEqual(['AccessExclusiveLock', 'ShareLock']);
    expect(brokenIndex?.newIndexes).toEqual(['appointments.appointments_starts_at_idx']);
    expect(modes(brokenIndex)).toEqual(['AccessExclusiveLock', 'ShareLock']);

    const fixedFile = fixed.files.find((f) => f.file === '0005_reminders.sql');
    const fixedIndex = fixedFile?.statements.find((s) => s.label.startsWith('create index concurrently if not exists appointments_starts_at_idx'));
    expect(fixedFile?.mode).toBe('per-statement');
    expect(fixedIndex?.newIndexes).toEqual(['appointments.appointments_starts_at_idx']);
    expect(modes(fixedIndex)).toEqual(['ShareUpdateExclusiveLock']);
    expect(fixedFile?.statements.flatMap((s) => s.rewrote)).toEqual([]);
  });

  test('(f) RLS probe as client_role with org A claims: cross-tenant rows on broken, only org A on fixed', () => {
    expect(broken.probes.rls).toEqual({
      user: '00000000-0000-4000-8000-000000000001',
      org: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tables: {
        appointments: { visible: 300, otherOrg: 150 },
        appointment_audit: { visible: 900, otherOrg: 450 },
      },
    });
    expect(fixed.probes.rls).toEqual({
      user: '00000000-0000-4000-8000-000000000001',
      org: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tables: {
        appointments: { visible: 150, otherOrg: 0 },
        appointment_audit: { visible: 306, otherOrg: 0 },
      },
    });
  });

  test('(g) the broken release stops at 0009 with 0002-0008 applied (partial); the fixed release applies to the end', () => {
    expect(broken.release).toEqual({
      status: 'partial',
      applied: RELEASE_FILES.slice(0, 7),
      failed: {
        file: '0009_client_name_required.sql',
        statement: 'alter table public.appointments alter column client_name set not null',
        error: 'column "client_name" of relation "appointments" contains null values',
      },
      notApplied: ['0009_client_name_required.sql'],
    });
    expect(fixed.release).toEqual({ status: 'complete', applied: RELEASE_FILES, notApplied: [] });
  });

  test('(h) re-run: release-fixed applies twice; release-broken fails at 0002 the second time', () => {
    expect(fixed.probes.rerun).toEqual({ status: 'complete' });
    expect(broken.probes.rerun).toEqual({
      status: 'failed',
      file: '0002_booking_settings.sql',
      error: 'relation "booking_settings" already exists',
    });
  });
});

describe('the review command', () => {
  const serverUrl = inject('serverUrl');

  test('(i) npm run review -- migrations/release-broken writes REVIEW_REPORT.md with 8 findings, FAIL, each retested clean on release-fixed, and exits 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-cli-'));
    const out = join(dir, 'REVIEW_REPORT.md');
    try {
      const run = promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', BROKEN, '--out', out], {
        env: { ...process.env, DATABASE_URL: serverUrl },
      });
      const failure = await run.then(
        () => undefined,
        (error: { code?: number; stdout?: string }) => error,
      );
      expect(failure?.code).toBe(1);
      expect(failure?.stdout).toContain('Retest against migrations/release-fixed: 0 finding(s) -> PASS');
      const report = readFileSync(out, 'utf8');
      expect(report).toContain('**Verdict: FAIL** - 8 finding(s) (Critical 1, High 5, Medium 2).');
      expect(report.match(/^\| \d+ \| `0\d{3}_/gm)).toHaveLength(8);
      expect(report.match(/\| not found in migrations\/release-fixed \|$/gm)).toHaveLength(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('an invalid index does not cover a foreign key', () => {
  const serverUrl = inject('serverUrl');

  test('(j) the fixed release plus a file that leaves the FK index invalid yields 1 FK-without-index finding on that file', async () => {
    // A failed CREATE INDEX CONCURRENTLY leaves the index behind marked invalid. The fixture
    // reproduces that state directly in pg_index (the review runs as a superuser on a scratch database).
    const dir = mkdtempSync(join(tmpdir(), 'review-invalid-index-'));
    try {
      cpSync(FIXED, dir, { recursive: true });
      writeFileSync(
        join(dir, '0010_invalid_fk_index.sql'),
        `-- 0010: the index behind appointments.assigned_member_id is left invalid, as after a failed CONCURRENTLY build.
update pg_catalog.pg_index set indisvalid = false
where indexrelid = 'public.appointments_assigned_member_id_idx'::regclass;
`,
      );
      const result = await reviewRelease({ serverUrl, releaseDir: dir });
      expect(result.release.status).toBe('complete');
      expect(result.findings.map((f) => ({ check: f.check, file: f.file, object: f.object, severity: f.severity }))).toEqual([
        { check: 'fk-without-index', file: '0010_invalid_fk_index.sql', object: 'appointments.assigned_member_id', severity: 'Medium' },
      ]);
      expect(result.verdict).toBe('CONDITIONAL PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
