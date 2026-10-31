import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toLedgerState, type ServerRows } from '../../src/connected/mapRows';
import { memberSummary } from '../../src/domain/ledger';
import { collectionReport } from '../../src/domain/reports';
import { freshDb, member, MEMBER, officer, service, type TestDb, type Who } from './harness';
import { FakeProvider, pgRpc } from './doubles';
import { createCheckout } from '../../supabase/functions/_shared/checkout.ts';

// The connected screens compute display figures from rows the API returns.
// These tests read the same rows the browser would (as the signed-in user, so
// RLS applies), map them with the real mapper, and compare with the database's
// own totals.

let db: TestDb;
beforeAll(async () => {
  db = await freshDb();
  // Add some activity: a pending attempt, a payment with excess, and an adjustment.
  await db.pool.query(`update app.settings set payment_provider = 'test-fake'`);
  const fake = new FakeProvider();
  const [annualA] = (await db.pool.query(`select id from public.charges where member_id = $1 and title like 'Annual%'`, [MEMBER.A])).rows;
  const a1 = await createCheckout({ memberRpc: pgRpc(db, member(db, 'A')), serviceRpc: pgRpc(db, service), provider: fake, email: 'a@example.test', chargeIds: [annualA.id], callbackUrl: 'x' });
  const a2 = await createCheckout({ memberRpc: pgRpc(db, member(db, 'A')), serviceRpc: pgRpc(db, service), provider: fake, email: 'a@example.test', chargeIds: [annualA.id], callbackUrl: 'x' });
  if (!a1.ok || !a2.ok) throw new Error('checkout failed');
  for (const [ref, pref] of [[a1.reference, 'MAP-1'], [a2.reference, 'MAP-2']]) {
    await db.q(service, `select public.server_post_verified_payment('test-fake', $1, $2, 1500000, 'NGN', now(), null, 'test')`, [pref, ref]);
  }
  const [welfareC] = (await db.pool.query(`select id from public.charges where member_id = $1 and title like 'Welfare%'`, [MEMBER.C])).rows;
  await db.q(officer(db), `select public.add_adjustment($1, -100000, 'Partial waiver (fictional)')`, [welfareC.id]);
});
afterAll(async () => { await db?.close(); });

async function readAs(who: Who, isOfficer: boolean): Promise<ServerRows> {
  const q = (sql: string) => db.q<Record<string, unknown>>(who, sql);
  const none = async () => [] as Record<string, unknown>[];
  const [clock] = await q('select public.ledger_clock() as t');
  return {
    clock: String((clock.t as Date).toISOString()),
    members: await q('select id, display_name, status, joined_on::text, reminder_channel, analytics_id from public.members'),
    rules: await q('select * from public.dues_rules'),
    levies: isOfficer ? await q('select *, issue_date::text as issue_date, due_date::text as due_date from public.levies') : await none(),
    levyTargets: isOfficer ? await q('select * from public.levy_targets') : await none(),
    charges: await q('select *, issue_date::text as issue_date, due_date::text as due_date from public.charges'),
    adjustments: await q('select * from public.adjustments'),
    attempts: await q('select id, reference, member_id, amount_kobo, status, created_at, updated_at, verification_checks from public.payment_attempts'),
    attemptCharges: await q('select * from public.payment_attempt_charges'),
    payments: await q('select id, provider_ref, attempt_id, member_id, amount_kobo, confirmed_at, source, fee_kobo from public.payments'),
    allocations: await q('select * from public.allocations'),
    receipts: await q('select * from public.receipts'),
    outbox: isOfficer ? await q('select * from public.outbox_messages') : await none(),
    tasks: isOfficer ? await q('select * from public.tasks') : await none(),
    jobRuns: isOfficer ? await q('select * from public.job_runs order by ran_at') : await none(),
    audit: isOfficer ? await q('select * from public.audit_events order by id') : await none(),
  };
}

describe('connected screens agree with the database', () => {
  it.each(['A', 'B', 'C', 'D'] as const)('Member %s sees figures equal to member_balances', async (k) => {
    const ledger = toLedgerState(await readAs(member(db, k), false));
    expect(ledger.members.map((m) => m.id)).toEqual([MEMBER[k]]);
    const mine = memberSummary(ledger, MEMBER[k]);
    const [server] = await db.q<Record<string, string>>(member(db, k), 'select * from public.member_balances');
    expect([mine.outstandingKobo, mine.overdueKobo, mine.upcomingKobo, mine.creditKobo, mine.paidKobo]).toEqual(
      [server.outstanding_kobo, server.overdue_kobo, server.upcoming_kobo, server.credit_kobo, server.paid_kobo].map(Number),
    );
  });

  it('the officer report computed on screen equals the database report', async () => {
    const ledger = toLedgerState(await readAs(officer(db), true));
    const screen = collectionReport(ledger);
    const [{ r }] = await db.q<{ r: Record<string, number> & { checks: { ok: boolean }[] } }>(officer(db), 'select public.collection_report() r');
    expect([screen.assessedKobo, screen.collectedKobo, screen.allocatedKobo, screen.unappliedKobo, screen.outstandingKobo, screen.overdueKobo]).toEqual(
      [r.assessed_kobo, r.collected_kobo, r.allocated_kobo, r.unapplied_kobo, r.outstanding_kobo, r.overdue_kobo].map(Number),
    );
    expect(screen.checks.every((c) => c.ok)).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(screen.unappliedKobo).toBe(1_500_000);
  });
});
