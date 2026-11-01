import pg from 'pg';

let counter = 0;

export function withDatabase(url: string, dbName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${dbName}`;
  return parsed.toString();
}

export async function connect(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Run one SQL string on a short-lived connection. */
export async function runSql(url: string, sql: string): Promise<void> {
  const client = await connect(url);
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** Create a uniquely named scratch database on the server and return its URL. */
export async function createScratchDatabase(serverUrl: string, prefix: string, template?: string): Promise<{ name: string; url: string }> {
  const name = `${prefix}_${process.pid}_${Date.now()}_${counter++}`;
  await runSql(serverUrl, `create database ${name}${template ? ` template ${template}` : ''}`);
  return { name, url: withDatabase(serverUrl, name) };
}

export async function dropDatabase(serverUrl: string, name: string): Promise<void> {
  await runSql(serverUrl, `drop database if exists ${name} with (force)`);
}
