import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, test } from 'vitest';
import { connect, createScratchDatabase, dropDatabase } from '../src/db.js';
import { appliedFiles, applyBaseAndSeed } from '../src/runner.js';
import { splitStatements } from '../src/sql.js';

const ORG_A_USER = '00000000-0000-4000-8000-000000000001';

describe('base schema and seed', () => {
  const serverUrl = inject('serverUrl');
  let db: { name: string; url: string };
  let client: pg.Client;

  beforeAll(async () => {
    db = await createScratchDatabase(serverUrl, 'base_test');
    client = await connect(db.url);
    await applyBaseAndSeed(client);
  });

  afterAll(async () => {
    await client?.end();
    if (db) await dropDatabase(serverUrl, db.name);
  });

  test('the runner records the base and seed files in the ledger', async () => {
    expect(await appliedFiles(client)).toEqual(['0001_base.sql', '0001_seed.sql']);
  });

  test('the seed has 2 organizations, 8 members, 300 appointments (12 without a name), 300 audit rows', async () => {
    const { rows } = await client.query(`
      select (select count(*) from organizations)::int as orgs,
             (select count(*) from members)::int as members,
             (select count(*) from appointments)::int as appointments,
             (select count(*) from appointments where client_name is null)::int as unnamed,
             (select count(*) from appointment_audit)::int as audit`);
    expect(rows[0]).toEqual({ orgs: 2, members: 8, appointments: 300, unnamed: 12, audit: 300 });
  });

  test('RLS: client_role with org A claims reads 150 appointments and 150 audit rows, all of org A', async () => {
    await client.query('begin');
    try {
      await client.query('set local role client_role');
      await client.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: ORG_A_USER })]);
      const { rows } = await client.query(`
        select (select count(*) from appointments)::int as visible,
               (select count(*) from appointments where org_id <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')::int as other_org,
               (select count(*) from appointment_audit)::int as audit`);
      expect(rows[0]).toEqual({ visible: 150, other_org: 0, audit: 150 });
    } finally {
      await client.query('rollback');
    }
  });

  test('RLS: client_role without claims reads 0 appointments', async () => {
    await client.query('begin');
    try {
      await client.query('set local role client_role');
      const { rows } = await client.query(`select count(*)::int as n from appointments`);
      expect(rows[0].n).toBe(0);
    } finally {
      await client.query('rollback');
    }
  });
});

describe('statement splitter', () => {
  test('keeps dollar-quoted bodies, strings and comments with ; inside one statement', () => {
    const sql = `-- a; comment\ncreate function f() returns int language sql as $$ select 1; $$;\nselect 'a;b';\n/* x; */ select $t$;$t$;\n-- trailing comment only`;
    expect(splitStatements(sql)).toHaveLength(3);
  });
});
