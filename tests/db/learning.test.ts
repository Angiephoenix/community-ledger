import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, type TestDb } from './harness';

// Runs every ```sql example in docs/LEARNING-GUIDE.md against the seeded test
// database, so the guide cannot drift from the schema.

const guide = readFileSync(resolve(__dirname, '../../docs/LEARNING-GUIDE.md'), 'utf8');
const blocks = [...guide.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1].trim());

let db: TestDb;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db?.close(); });

describe('learning guide SQL', () => {
  it('has examples', () => expect(blocks.length).toBeGreaterThanOrEqual(10));

  it.each(blocks.map((b, i) => [i + 1, b.split('\n')[0].slice(0, 60), b]))('example %i runs: %s', async (_i, _title, sql) => {
    const c = await db.pool.connect();
    try {
      // The RLS example manages its own transaction; others run in one we roll back.
      if (!/^begin;/i.test(sql as string)) await c.query('begin');
      await c.query(sql as string);
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });

  it('quoted figures match the seed', async () => {
    const [a] = (await db.pool.query(`select outstanding_kobo, overdue_kobo, upcoming_kobo from public.member_balances where display_name = 'Member A'`)).rows;
    expect([a.outstanding_kobo, a.overdue_kobo, a.upcoming_kobo].map(Number)).toEqual([3_000_000, 1_500_000, 1_500_000]);
    const [r] = (await db.pool.query(`select (select sum(amount_kobo) from public.payments) ok, (select sum(p.amount_kobo) from public.payments p join public.allocations a on a.payment_id = p.id) wrong`)).rows;
    expect([Number(r.ok), Number(r.wrong)]).toEqual([4_000_000, 11_000_000]);
  });

  it('the RLS example shows one member and no other payments', async () => {
    const sql = blocks.find((b) => b.startsWith('begin;'))!;
    const c = await db.pool.connect();
    try {
      const results = (await c.query(sql)) as unknown as { rows: Record<string, unknown>[] }[];
      const rows = results.filter((r) => r.rows?.length).map((r) => r.rows);
      expect(rows.some((r) => r.length === 1 && r[0].display_name === 'Member A')).toBe(true);
      expect(rows.some((r) => r[0]?.other_members_payments !== undefined && Number(r[0].other_members_payments) === 0)).toBe(true);
    } finally {
      await c.query('rollback').catch(() => {});
      c.release();
    }
  });
});
