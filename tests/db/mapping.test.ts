import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup as renderToStaticMarkupSync } from 'react-dom/server';
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

describe('connected screens: wording and the pay button (rendered with real rows)', () => {
  // Rendered on the server with the connected build's labels. Uses a fresh
  // copy of the seed: Member C's 19 November payment is still pending and is
  // past the 48-hour pause on the 24 November test clock.
  async function render(node: unknown) {
    const { renderToStaticMarkup } = await import('react-dom/server');
    return renderToStaticMarkup(node as never).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  }
  async function connectedUi() {
    vi.resetModules();
    vi.stubEnv('VITE_APP_MODE', 'connected');
    const React = await import('react');
    const [{ MemberOverview }, { MemberStatement }, { Reports }, { NeedsAttention }, { Members }] = await Promise.all([
      import('../../src/ui/member/MemberOverview'), import('../../src/ui/member/MemberStatement'),
      import('../../src/ui/officer/Reports'), import('../../src/ui/officer/NeedsAttention'), import('../../src/ui/officer/Members'),
    ]);
    return { h: React.createElement, MemberOverview, MemberStatement, Reports, NeedsAttention, Members };
  }
  let fresh: TestDb;
  beforeAll(async () => { fresh = await freshDb(); });
  afterAll(async () => { vi.unstubAllEnvs(); await fresh?.close(); });
  const readFresh = async (who: Who, isOfficer: boolean) => { const keep = db; db = fresh; try { return await readAs(who, isOfficer); } finally { db = keep; } };

  it('Member C: an unconfirmed payment past the pause offers "Pay again", with the risk spelled out', async () => {
    const ui = await connectedUi();
    const ledger = toLedgerState(await readFresh(member(fresh, 'C'), false));
    const text = await render(ui.h(ui.MemberOverview, { ledger, memberId: MEMBER.C, onViewReceipt: () => {}, onGo: () => {} }));
    expect(text).toMatch(/has not been confirmed after 48 hours\. Nothing was credited from it/);
    expect(text).toMatch(/Earlier payment not confirmed/);
    expect(text).toMatch(/Pay again ₦20,000/);
    expect(text).toMatch(/If both go through, the extra is kept as credit/);
    expect(text).not.toMatch(/We’re checking a payment/);
  });

  it('Member C inside the pause: the button is disabled and says why', async () => {
    const ui = await connectedUi();
    // 21 November 10:00: the annual dues are overdue (so preselected) and the
    // 19 November 15:00 payment is 43 hours old, inside the pause.
    await fresh.pool.query(`update app.settings set clock_override = '2026-11-21 10:00 Africa/Lagos'`);
    try {
      const ledger = toLedgerState(await readFresh(member(fresh, 'C'), false));
      const html = renderToStaticMarkupSync(ui.h(ui.MemberOverview, { ledger, memberId: MEMBER.C, onViewReceipt: () => {}, onGo: () => {} }));
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Payment being checked/);
      expect(html).toMatch(/You can pay again if it isn’t confirmed within 48 hours/);
    } finally {
      await fresh.pool.query(`update app.settings set clock_override = '2026-11-24 10:00 Africa/Lagos'`);
    }
  });

  it('statements, reports, members and Needs attention use test-system wording, hours and names', async () => {
    const ui = await connectedUi();
    const mine = toLedgerState(await readFresh(member(fresh, 'A'), false));
    const statement = await render(ui.h(ui.MemberStatement, { ledger: mine, memberId: MEMBER.A, onViewReceipt: () => {} }));
    expect(statement).toMatch(/Test system with fictional records/);
    expect(statement).not.toMatch(/Demo/);

    await fresh.pool.query(`select public.server_link_member_user($1, $2)`, [MEMBER.D, fresh.users.D]);
    const all = toLedgerState(await readFresh(officer(fresh), true));
    // A line written before the wording change, as stored on the live test project.
    all.audit.push({ id: 'old', at: all.now, actor: 'system', action: 'Account linked', detail: `Member ${MEMBER.C} linked to a sign-in account` });
    all.tasks.push({ ...all.tasks[0], id: 'old-task', key: 'old', status: 'open', detail: 'Attempt CL-X for ₦1 has not been confirmed after 48:00:00. Nothing was credited from it.' });
    const reports = await render(ui.h(ui.Reports, { ledger: all }));
    expect(reports).toMatch(/Test system with fictional records/);
    expect(reports).toMatch(/not tracked in this test system/);
    expect(reports).toMatch(/1 unconfirmed payment attempt \(₦20,000\) is not counted/);
    expect(reports).toMatch(/Member D linked to a sign-in account/);
    expect(reports).toMatch(/Member C linked to a sign-in account/);
    expect(reports).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(reports).not.toMatch(/Demo|this demo/);
    const attention = await render(ui.h(ui.NeedsAttention, { ledger: all }));
    expect(attention).toMatch(/after 48 hours\./);
    expect(attention).not.toMatch(/48:00:00/);
    const members = await render(ui.h(ui.Members, { ledger: all, onViewReceipt: () => {} }));
    expect(members).not.toMatch(/connected version/);
    expect(members).toMatch(/set up by the system administrator; there is no screen to add or edit them yet/);
  });
});
