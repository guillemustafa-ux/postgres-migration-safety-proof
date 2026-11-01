import type { Finding, ReviewResult } from './review.js';
import { label } from './sql.js';

const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function summaryLine(result: ReviewResult): string {
  return `${countLine(result)} -> ${result.verdict}`;
}

function countLine(result: ReviewResult): string {
  const counts = (['Critical', 'High', 'Medium'] as const)
    .map((s) => [s, result.findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${s} ${n}`);
  return `${result.findings.length} finding(s)${counts.length ? ` (${counts.join(', ')})` : ''}`;
}

function retestOf(finding: Finding, retest?: ReviewResult): string {
  if (!retest) return 'not run';
  const still = retest.findings.some((f) => f.check === finding.check && f.object === finding.object);
  return still ? `still found in ${retest.releaseDir}` : `not found in ${retest.releaseDir}`;
}

/** REVIEW_REPORT.md: every number in it was measured by this run of the review. */
export function renderReport(result: ReviewResult, retest?: ReviewResult): string {
  const lines: string[] = [];
  lines.push(`# Migration review: \`${result.releaseDir}\``);
  lines.push('');
  lines.push(`**Verdict: ${result.verdict}** - ${countLine(result)}.`);
  lines.push('');
  lines.push(`- Reviewed on a scratch copy (base schema + seed, then the release), PostgreSQL ${result.serverVersion}.`);
  lines.push(
    retest
      ? `- Retest against \`${retest.releaseDir}\`: ${summaryLine(retest)}.`
      : '- Retest: none (pass a corrected release with `--retest <dir>`).',
  );
  lines.push('- Severity: Critical = data of one tenant readable by another; High = data integrity, availability or privilege risk; Medium = operational risk.');
  lines.push('- Verdict: FAIL if any Critical or High finding; CONDITIONAL PASS if only Medium; PASS if none.');
  lines.push('');

  lines.push('## Findings');
  lines.push('');
  if (result.findings.length === 0) {
    lines.push('No findings.');
  } else {
    lines.push('| # | File | Object | Finding | Severity | Impact (measured in this run) | Fix | Retest |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    result.findings.forEach((f, i) => {
      lines.push(
        `| ${i + 1} | \`${f.file}\` | \`${cell(f.object)}\` | ${cell(f.finding)} | ${f.severity} | ${cell(f.impact)} | ${cell(f.fix)} | ${cell(retestOf(f, retest))} |`,
      );
    });
  }
  lines.push('');

  lines.push('## Release state (from the migration ledger)');
  lines.push('');
  lines.push(`- Status: **${result.release.status}**`);
  lines.push(`- Applied: ${result.release.applied.map((f) => `\`${f}\``).join(', ') || 'none'}`);
  if (result.release.failed) {
    lines.push(`- Failed: \`${result.release.failed.file}\` at \`${cell(result.release.failed.statement)}\`: ${result.release.failed.error}`);
  }
  lines.push(`- Not applied: ${result.release.notApplied.map((f) => `\`${f}\``).join(', ') || 'none'}`);
  lines.push('');

  lines.push('## Probes');
  lines.push('');
  const { trigger, rls, rerun } = result.probes;
  if (trigger) lines.push(`- Trigger side effect: 1 UPDATE on \`${trigger.table}\` wrote ${trigger.auditRowsPerUpdate} row(s) in \`${trigger.auditTable}\` (expected 1).`);
  if (rls) {
    const t = Object.entries(rls.tables).map(([name, v]) => `\`${name}\` ${v.visible} visible, ${v.otherOrg} of other organizations`);
    lines.push(`- RLS as \`client_role\` with the claims of user \`${rls.user}\` (organization \`${rls.org}\`): ${t.join('; ')}.`);
  }
  if (rerun) lines.push(`- Re-run on a copy: ${rerun.status === 'complete' ? 'the second application completed' : `the second application failed at \`${rerun.file}\`: ${rerun.error}`}.`);
  lines.push('');

  lines.push('## Harness record, per file');
  lines.push('');
  lines.push('Locks are read from `pg_locks` by a second connection while the statement\'s transaction is held open (for `CONCURRENTLY`, while the build waits). Only tables of schema `public` are listed.');
  lines.push('');
  lines.push('| File | Mode | # | Statement | ms | Locks held at the checkpoint | Rewrote | New index |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const file of result.files) {
    file.statements.forEach((s, i) => {
      const locks = s.locks.map((l) => `${l.table}: ${l.mode}`).join(', ');
      lines.push(
        `| \`${file.file}\` | ${file.mode} | ${i + 1} | \`${cell(s.label)}\` | ${s.ms} | ${locks || '-'} | ${s.rewrote.join(', ') || '-'} | ${s.newIndexes.join(', ') || '-'} |`,
      );
    });
    if (!file.ok) lines.push(`| \`${file.file}\` | ${file.mode} | ${file.statements.length + 1} | \`${cell(label(file.failedStatement ?? ''))}\` | - | FAILED: ${cell(file.error ?? '')} | - | - |`);
  }
  lines.push('');
  return lines.join('\n');
}
