import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface Server {
  /** Connection URL of a maintenance database on the server (used to create and drop scratch databases). */
  url: string;
  /** `embedded` when this process started Postgres; `external` when DATABASE_URL was used. */
  kind: 'embedded' | 'external';
  stop(): Promise<void>;
}

/**
 * One real Postgres for a review or a test run.
 *  - DATABASE_URL set: use that server. Only throwaway databases created by this repo are written to.
 *  - otherwise: start Postgres 16 with `embedded-postgres` in a fresh directory under the OS temp dir
 *    (never inside the repo) and remove it afterwards.
 */
export async function startServer(): Promise<Server> {
  const external = (process.env.DATABASE_URL || '').replace(/"/g, '');
  if (external) return { url: external, kind: 'external', stop: async () => {} };

  const dataRoot = mkdtempSync(join(tmpdir(), 'pg-migration-safety-'));
  const port = await freePort();
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  // Quiet on success, but keep the output so a failed initdb/start can say why.
  const output: string[] = [];
  const keep = (message: unknown) => output.push(...describe(message).split(/\r?\n/));
  const server = new EmbeddedPostgres({
    databaseDir: join(dataRoot, 'data'),
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    onLog: keep,
    onError: keep,
  });
  try {
    await server.initialise();
    await server.start();
  } catch (reason) {
    throw new Error(`embedded-postgres failed to start: ${describe(reason)}\n${output.slice(-40).join('\n')}`);
  }
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    kind: 'embedded',
    stop: async () => {
      await server.stop();
      rmSync(dataRoot, { recursive: true, force: true });
    },
  };
}

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  return typeof value === 'string' ? value : String(value);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
