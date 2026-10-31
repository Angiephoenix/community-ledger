import { inject } from 'vitest';
import pg from 'pg';

// Each test file gets its own database cloned from the seeded template.

export const MEMBER = {
  A: '00000000-0000-4000-8000-00000000000a',
  B: '00000000-0000-4000-8000-00000000000b',
  C: '00000000-0000-4000-8000-00000000000c',
  D: '00000000-0000-4000-8000-00000000000d',
} as const;

export type Who =
  | { kind: 'anon' }
  | { kind: 'user'; userId: string; metadata?: Record<string, unknown> }
  | { kind: 'service' }
  | { kind: 'owner' };

export interface TestDb {
  pool: pg.Pool;
  users: { A: string; B: string; C: string; D: string; officer: string; stranger: string };
  /** Runs `fn` in one transaction as the given API role, exactly as Supabase sets it up. */
  as<T>(who: Who, fn: (c: pg.PoolClient) => Promise<T>): Promise<T>;
  /** Shorthand: one query as `who`, returning rows. */
  q<T = Record<string, unknown>>(who: Who, sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

let counter = 0;

export async function freshDb(): Promise<TestDb> {
  const port = inject('pgPort');
  const name = `t_${process.pid}_${Date.now()}_${counter++}`;
  const admin = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
  await admin.connect();
  await admin.query(`create database ${name} template cl_template`);
  await admin.end();
  const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', database: name, max: 12 });

  async function as<T>(who: Who, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try {
      await c.query('begin');
      if (who.kind === 'anon') {
        await c.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`);
        await c.query('set local role anon');
      } else if (who.kind === 'user') {
        const claims = { sub: who.userId, role: 'authenticated', user_metadata: who.metadata ?? {} };
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        await c.query('set local role authenticated');
      } else if (who.kind === 'service') {
        await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
        await c.query('set local role service_role');
      }
      const out = await fn(c);
      await c.query('commit');
      return out;
    } catch (e) {
      await c.query('rollback').catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }

  // Sign-in accounts for the fictional members, an officer and an unlinked user.
  const mk = async (email: string, meta: Record<string, unknown> = {}) =>
    (await pool.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, meta])).rows[0].id as string;
  const users = {
    A: await mk('member-a@example.test'),
    B: await mk('member-b@example.test'),
    C: await mk('member-c@example.test'),
    D: await mk('member-d@example.test'),
    officer: await mk('officer@example.test'),
    // Claims to be an officer in editable metadata. Must not be treated as one.
    stranger: await mk('stranger@example.test', { role: 'officer', is_officer: true }),
  };
  for (const k of ['A', 'B', 'C', 'D'] as const) await pool.query('select public.server_link_member_user($1, $2)', [MEMBER[k], users[k]]);
  await pool.query(`select public.server_grant_officer($1, 'test setup')`, [users.officer]);

  return {
    pool,
    users,
    as,
    q: (who, sql, params) => as(who, async (c) => (await c.query(sql, params)).rows),
    async close() {
      await pool.end();
      const a = new pg.Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' });
      await a.connect();
      await a.query(`drop database if exists ${name} with (force)`);
      await a.end();
    },
  };
}

export const member = (db: TestDb, k: 'A' | 'B' | 'C' | 'D'): Who => ({ kind: 'user', userId: db.users[k] });
export const officer = (db: TestDb): Who => ({ kind: 'user', userId: db.users.officer });
export const service: Who = { kind: 'service' };
export const anon: Who = { kind: 'anon' };
export const owner: Who = { kind: 'owner' };
