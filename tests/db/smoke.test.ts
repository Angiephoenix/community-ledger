import { afterAll, beforeAll, describe, expect, it, inject } from 'vitest';
import { freshDb, member, MEMBER, type TestDb } from './harness';

let db: TestDb;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db?.close(); });

describe('fresh database', () => {
  it('applied every migration and the seed', () => {
    expect(inject('migrations')).toEqual([
      '20261031090000_core_schema.sql',
      '20261031090100_ledger_functions.sql',
      '20261031090200_security.sql',
      '20261101090000_verification_mismatch.sql',
    ]);
  });

  it('matches the milestone 1 scenario figures for Member A', async () => {
    const [row] = await db.q<Record<string, string>>(member(db, 'A'), 'select * from public.member_balances');
    expect(row.member_id).toBe(MEMBER.A);
    expect(Number(row.assessed_kobo)).toBe(3_500_000);
    expect(Number(row.paid_kobo)).toBe(500_000);
    expect(Number(row.outstanding_kobo)).toBe(3_000_000);
    expect(Number(row.overdue_kobo)).toBe(1_500_000);
    expect(Number(row.upcoming_kobo)).toBe(1_500_000);
  });
});
