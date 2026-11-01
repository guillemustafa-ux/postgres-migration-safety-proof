import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { renderReport, summaryLine } from './report.js';
import { reviewRelease } from './review.js';
import { startServer } from './server.js';

/**
 * npm run review -- <release-dir> [--retest <fixed-dir>] [--out <file>]
 *
 * Reviews <release-dir> on a scratch database and writes REVIEW_REPORT.md. When --retest is not
 * given and a sibling `release-fixed` directory exists, the findings are retested against it.
 * Exit code: 1 when the verdict is FAIL, 0 otherwise.
 */
const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith('--') && !['--retest', '--out'].includes(args[i - 1]));
const releaseDir = positional[0];
if (!releaseDir) {
  console.error('Usage: npm run review -- <release-dir> [--retest <fixed-dir>] [--out <file>]');
  process.exit(2);
}
const out = option('--out') ?? 'REVIEW_REPORT.md';
const sibling = join(dirname(resolve(releaseDir)), 'release-fixed');
const retestDir = option('--retest') ?? (existsSync(sibling) && sibling !== resolve(releaseDir) ? relative(process.cwd(), sibling).replace(/\\/g, '/') : undefined);

const server = await startServer();
try {
  const result = await reviewRelease({ serverUrl: server.url, releaseDir });
  const retest = retestDir ? await reviewRelease({ serverUrl: server.url, releaseDir: retestDir }) : undefined;
  writeFileSync(out, renderReport(result, retest));
  console.log(`Review of ${releaseDir} (PostgreSQL ${result.serverVersion}): ${summaryLine(result)}`);
  for (const f of result.findings) console.log(`  ${f.severity.padEnd(8)} ${f.file.padEnd(32)} ${f.object}  [${f.check}]`);
  if (retest) console.log(`Retest against ${retestDir}: ${summaryLine(retest)}`);
  console.log(`Report written to ${out}`);
  process.exitCode = result.verdict === 'FAIL' ? 1 : 0;
} finally {
  await server.stop();
}
