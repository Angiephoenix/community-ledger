import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { freshDb, type TestDb } from './harness';

// Runs the Deno tests for the Edge Function HTTP handlers against a fresh copy
// of the seeded database. Needs the `deno` dev dependency (npm package).

let db: TestDb;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db?.close(); });

describe('Edge Function handlers under Deno', () => {
  it('deno test passes', () => {
    const dbName = (db.pool as unknown as { options: { database: string } }).options.database;
    const r = spawnSync(resolve(__dirname, '../../node_modules/.bin/deno'), ['test', '-A', '--no-check=remote', 'functions_test.ts'], {
      cwd: resolve(__dirname, '../../supabase/functions/tests'),
      env: { ...process.env, NO_COLOR: '1', CL_PG_PORT: String(inject('pgPort')), CL_PG_DB: dbName, CL_USERS: JSON.stringify(db.users) },
      encoding: 'utf8',
      timeout: 240_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    process.stdout.write(`\n${out.split('\n').filter((l) => / \.\.\. (ok|FAILED)|^(ok|FAILED) \|/.test(l)).join('\n')}\n`);
    expect(r.status, out.slice(-4000)).toBe(0);
  }, 300_000);
});
