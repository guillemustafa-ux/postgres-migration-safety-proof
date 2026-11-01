import type { TestProject } from 'vitest/node';
import { startServer } from '../../src/server.js';

declare module 'vitest' {
  export interface ProvidedContext {
    serverUrl: string;
  }
}

/**
 * One real Postgres for the whole run: DATABASE_URL when set (CI), otherwise Postgres 16 started
 * with `embedded-postgres` under the OS temp dir. Every review creates its own throwaway
 * databases on it and drops them, so an existing DATABASE_URL is only written to inside those.
 */
export default async function setup(project: TestProject) {
  const server = await startServer();
  project.provide('serverUrl', server.url);
  return async () => {
    await server.stop();
  };
}
