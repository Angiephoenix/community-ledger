import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createCheckout } from '../../supabase/functions/_shared/checkout.ts';
import { receiveWebhook } from '../../supabase/functions/_shared/webhook.ts';
import { processProviderEvents, reconcileAttempts } from '../../supabase/functions/_shared/process.ts';
import { freshDb, member, MEMBER, officer, owner, service, type TestDb } from './harness';
import { FakeProvider, pgRpc } from './doubles';

// The payment pipeline end to end against a real PostgreSQL database, using a
// FAKE provider. These tests prove our own logic; they are not evidence about
// Paystack.

let db: TestDb;
let fake: FakeProvider;

const num = (v: unknown) => Number(v);
async function balances(k: 'A' | 'B' | 'C' | 'D') {
  const [r] = await db.q<Record<string, string>>(member(db, k), 'select * from public.member_balances');
  return { outstanding: num(r.outstanding_kobo), overdue: num(r.overdue_kobo), upcoming: num(r.upcoming_kobo), credit: num(r.credit_kobo), paid: num(r.paid_kobo) };
}
async function chargeId(k: 'A' | 'B' | 'C' | 'D', titlePrefix: string) {
  const [r] = await db.q<{ id: string }>(owner, `select id from public.charges where member_id = $1 and title like $2`, [MEMBER[k], `${titlePrefix}%`]);
  return r.id;
}
async function counts() {
  const [r] = await db.q<Record<string, string>>(owner, `select
    (select count(*) from public.payments) payments, (select count(*) from public.allocations) allocations,
    (select count(*) from public.receipts) receipts,
    (select count(*) from app.analytics_outbox where event = 'payment confirmed') confirmed_events,
    (select count(*) from app.analytics_outbox where event = 'payment started') started_events`);
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}
const providers = () => ({ [fake.id]: fake });
const checkout = (k: 'A' | 'B' | 'C' | 'D', chargeIds: string[]) =>
  createCheckout({
    memberRpc: pgRpc(db, member(db, k)), serviceRpc: pgRpc(db, service), provider: fake,
    email: `member-${k.toLowerCase()}@example.test`, chargeIds, callbackUrl: 'http://localhost:5173/?payment=return',
  });
async function deliverWebhook(reference: string, event = 'charge.success') {
  const { rawBody, headers } = await fake.webhook(reference, event);
  return receiveWebhook({ rawBody, headers, provider: fake, serviceRpc: pgRpc(db, service) });
}
const process = (extra: Partial<Parameters<typeof processProviderEvents>[0]> = {}) =>
  processProviderEvents({ serviceRpc: pgRpc(db, service), providers: providers(), ...extra });

beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db?.close(); });

beforeEach(async () => {
  // Fresh database per test for independence.
  await db.close();
  db = await freshDb();
  await db.pool.query(`update app.settings set payment_provider = 'test-fake'`);
  fake = new FakeProvider();
});

describe('Scenario A: ordinary payment through checkout, webhook and processing', () => {
  it('credits only after server-side verification, atomically', async () => {
    const before = await counts();
    const co = await checkout('A', [await chargeId('A', 'Annual dues')]);
    expect(co.ok).toBe(true);
    if (!co.ok) return;
    expect(co.amountKobo).toBe(1_500_000); // the database's amount, not the browser's
    expect(fake.checkouts[0].amountKobo).toBe(1_500_000);

    // Customer returns from the hosted page before any confirmation: nothing credited.
    expect((await balances('A')).outstanding).toBe(3_000_000);

    fake.settle(co.reference, { status: 'success' });
    const hook = await deliverWebhook(co.reference);
    expect(hook.status).toBe(200);
    expect((await balances('A')).outstanding).toBe(3_000_000); // recorded, not yet processed

    const s = await process();
    expect(s.recorded).toBe(1);
    const after = await balances('A');
    expect(after.outstanding).toBe(1_500_000);
    expect(after.overdue).toBe(0);
    const c = await counts();
    expect(c.payments - before.payments).toBe(1);
    expect(c.allocations - before.allocations).toBe(1);
    expect(c.receipts - before.receipts).toBe(1);
    expect(c.confirmed_events).toBe(1);
    expect(c.started_events).toBe(1);

    const [msg] = await db.q<{ status: string; status_reason: string }>(owner,
      `select status, status_reason from public.outbox_messages where charge_id = $1 and kind = 'reminder-overdue'`, [await chargeId('A', 'Annual dues')]);
    expect(msg).toEqual({ status: 'cancelled', status_reason: 'Paid before sending' });

    const [rep] = await db.q<{ r: { checks: { ok: boolean }[] } }>(officer(db), 'select public.collection_report() r');
    expect(rep.r.checks.every((x) => x.ok)).toBe(true);
  });
});

describe('Scenario B: duplicate and late confirmations', () => {
  it('a repeated webhook and a second event for the same transaction change nothing', async () => {
    const co = await checkout('A', [await chargeId('A', 'Annual dues')]);
    if (!co.ok) throw new Error('checkout failed');
    fake.settle(co.reference, { status: 'success' });
    await deliverWebhook(co.reference);
    await process();
    const once = await counts();

    const again = await deliverWebhook(co.reference); // identical delivery
    expect(again).toMatchObject({ status: 200, isNew: false });
    expect((await process()).claimed).toBe(0);

    await deliverWebhook(co.reference, 'charge.success.retry'); // different event, same transaction
    const s = await process();
    expect(s.duplicates).toBe(1);

    await reconcileAttempts({ serviceRpc: pgRpc(db, service), providers: providers(), olderThanSeconds: 0 });
    expect(await counts()).toEqual(once);
    expect((await balances('A')).outstanding).toBe(1_500_000);
  });

  it('a late confirmation for an abandoned checkout is still recorded', async () => {
    const co = await checkout('A', [await chargeId('A', 'Annual dues')]);
    if (!co.ok) throw new Error('checkout failed');
    const [attempt] = await db.q<{ id: string }>(owner, 'select id from public.payment_attempts where reference = $1', [co.reference]);
    const [ab] = await db.q<{ s: string }>(member(db, 'A'), 'select public.abandon_payment_attempt($1) s', [attempt.id]);
    expect(ab.s).toBe('abandoned');
    fake.settle(co.reference, { status: 'success' });
    await deliverWebhook(co.reference);
    expect((await process()).recorded).toBe(1);
    expect((await balances('A')).outstanding).toBe(1_500_000);
  });
});

describe('Scenario C: pending, failed, abandoned and outages', () => {
  it('pending and failed never reduce debt; pending pauses reminders, an opened checkout does not', async () => {
    const levy = await chargeId('A', 'Community project levy');
    const co = await checkout('A', [levy]);
    if (!co.ok) throw new Error('checkout failed');
    // Checkout opened only: reminders not paused.
    let [job] = await db.q<{ r: { paused: number } }>(officer(db), 'select public.run_reminder_job() r');
    expect(job.r.paused).toBe(0);

    fake.settle(co.reference, { status: 'pending', paidAt: null });
    await reconcileAttempts({ serviceRpc: pgRpc(db, service), providers: providers(), olderThanSeconds: 0 });
    const [att] = await db.q<{ status: string }>(owner, 'select status from public.payment_attempts where reference = $1', [co.reference]);
    expect(att.status).toBe('pending');
    expect((await balances('A')).outstanding).toBe(3_000_000);

    // A second levy-style charge would be paused now; the levy reminder already exists so check pausing directly.
    const [p] = await db.q<{ id: string | null }>(owner, 'select (app.pausing_attempt($1)).id', [levy]);
    expect(p.id).not.toBeNull();

    fake.settle(co.reference, { status: 'failed' });
    await reconcileAttempts({ serviceRpc: pgRpc(db, service), providers: providers(), olderThanSeconds: 0 });
    const [att2] = await db.q<{ status: string }>(owner, 'select status from public.payment_attempts where reference = $1', [co.reference]);
    expect(att2.status).toBe('failed');
    expect((await balances('A')).outstanding).toBe(3_000_000);
    expect((await counts()).payments).toBe(2);
    [job] = await db.q<{ r: { paused: number } }>(officer(db), 'select public.run_reminder_job() r');
    expect(job.r.paused).toBe(0);
  });

  it('provider abandoned status closes the attempt without crediting', async () => {
    const co = await checkout('A', [await chargeId('A', 'Welfare')]);
    if (!co.ok) throw new Error('checkout failed');
    fake.settle(co.reference, { status: 'abandoned', paidAt: null });
    await reconcileAttempts({ serviceRpc: pgRpc(db, service), providers: providers(), olderThanSeconds: 0 });
    const [att] = await db.q<{ status: string }>(owner, 'select status from public.payment_attempts where reference = $1', [co.reference]);
    expect(att.status).toBe('abandoned');
    expect((await balances('A')).outstanding).toBe(3_000_000);
  });

  it('an outage when opening checkout leaves nothing that looks like a payment being checked', async () => {
    fake.down = true;
    const co = await checkout('A', [await chargeId('A', 'Annual dues')]);
    expect(co).toMatchObject({ ok: false, code: 'provider-unavailable' });
    const rows = await db.q<{ status: string; closed_reason: string }>(owner, `select status, closed_reason from public.payment_attempts where member_id = $1 and provider = 'test-fake'`, [MEMBER.A]);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('abandoned');
    expect(rows[0].closed_reason).toMatch(/could not be opened/);
  });

  it('an outage during processing retries later and credits exactly once', async () => {
    const co = await checkout('A', [await chargeId('A', 'Annual dues')]);
    if (!co.ok) throw new Error('checkout failed');
    fake.settle(co.reference, { status: 'success' });
    await deliverWebhook(co.reference);
    fake.down = true;
    expect((await process()).retried).toBe(1);
    expect((await counts()).payments).toBe(2);
    const [ev] = await db.q<{ status: string; last_error: string }>(owner, 'select status, last_error from app.provider_events');
    expect(ev.status).toBe('received');
    expect(ev.last_error).toMatch(/Provider unavailable/);
    expect((await process()).claimed).toBe(0); // backing off
    await db.pool.query('update app.provider_events set next_attempt_at = now()');
    fake.down = false;
    expect((await process()).recorded).toBe(1);
    expect((await counts()).payments).toBe(3);
  });

  it('invalid webhook signatures are rejected and nothing is stored', async () => {
    const { rawBody } = await fake.webhook('CL-ANY');
    const r = await receiveWebhook({ rawBody, headers: new Headers({ 'x-fake-signature': 'deadbeef' }), provider: fake, serviceRpc: pgRpc(db, service) });
    expect(r.status).toBe(401);
    const [n] = await db.q<{ n: string }>(owner, 'select count(*) n from app.provider_events');
    expect(Number(n.n)).toBe(0);
  });

  it('if the event cannot be stored the webhook is not acknowledged', async () => {
    const { rawBody, headers } = await fake.webhook('CL-ANY');
    const failing = { call: async () => { throw new Error('database unavailable'); } };
    const r = await receiveWebhook({ rawBody, headers, provider: fake, serviceRpc: failing });
    expect(r.status).toBe(500);
  });
});

describe('verification mismatches are held, never credited', () => {
  it.each([
    ['amount', { amountKobo: 100 }],
    ['currency', { currency: 'USD' }],
    ['environment', { environment: 'live' }],
  ])('%s mismatch', async (_label, patch) => {
    const co = await checkout('A', [await chargeId('A', 'Annual dues')]);
    if (!co.ok) throw new Error('checkout failed');
    fake.settle(co.reference, { status: 'success', ...patch });
    await deliverWebhook(co.reference);
    expect((await process()).held).toBe(1);
    expect((await counts()).payments).toBe(2);
    const tasks = await db.q<{ type: string }>(owner, `select type from public.tasks where type = 'held-event'`);
    expect(tasks).toHaveLength(1);
    expect((await balances('A')).outstanding).toBe(3_000_000);
  });

  it('a provider answer about a different reference is held', async () => {
    const co = await checkout('A', [await chargeId('A', 'Annual dues')]);
    if (!co.ok) throw new Error('checkout failed');
    fake.settle(co.reference, { status: 'success', reference: 'CL-SOMETHINGELSE' });
    await deliverWebhook(co.reference);
    expect((await process()).held).toBe(1);
    expect((await counts()).payments).toBe(2);
  });
});

describe('Scenario D: concurrent distinct payments', () => {
  it('two overlapping postings for the same charge keep all money and never over-allocate', async () => {
    const annual = await chargeId('A', 'Annual dues');
    const a1 = await checkout('A', [annual]);
    const a2 = await checkout('A', [annual]);
    if (!a1.ok || !a2.ok) throw new Error('checkout failed');
    const post = (c: pg.PoolClient, ref: string, providerRef: string) =>
      c.query(`select public.server_post_verified_payment('test-fake', $1, $2, 1500000, 'NGN', now(), null, 'test') r`, [providerRef, ref]);

    // Force a real overlap: the first transaction holds its locks while the second starts.
    const c1 = await db.pool.connect();
    const c2 = await db.pool.connect();
    try {
      for (const c of [c1, c2]) {
        await c.query('begin');
        await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
        await c.query('set local role service_role');
      }
      await post(c1, a1.reference, 'FAKE-D1');
      const second = post(c2, a2.reference, 'FAKE-D2').then(async (r) => { await c2.query('commit'); return r; });
      await new Promise((r) => setTimeout(r, 200));
      const [{ waiting }] = (await db.pool.query(`select count(*)::int as waiting from pg_stat_activity where wait_event_type = 'Lock'`)).rows;
      expect(waiting).toBeGreaterThanOrEqual(1); // the second posting is genuinely blocked
      await c1.query('commit');
      const r2 = (await second).rows[0].r;
      expect(r2.outcome).toBe('recorded');
      expect(Number(r2.unapplied_kobo)).toBe(1_500_000);
    } finally {
      c1.release();
      c2.release();
    }
    const [alloc] = await db.q<{ s: string }>(owner, 'select sum(amount_kobo) s from public.allocations where charge_id = $1', [annual]);
    expect(Number(alloc.s)).toBe(2_000_000); // 500,000 opening + 1,500,000; never more than the charge
    const bal = await balances('A');
    expect(bal.outstanding).toBe(1_500_000);
    expect(bal.credit).toBe(1_500_000);
    const credit = await db.q(owner, `select 1 from public.tasks where type = 'unapplied-credit' and status = 'open'`);
    expect(credit).toHaveLength(1);
  });

  it('many simultaneous payments for one charge: every naira kept, allocation capped', async () => {
    const welfare = await chargeId('C', 'Welfare');
    const refs: string[] = [];
    for (let i = 0; i < 6; i++) {
      const co = await checkout('C', [welfare]);
      if (!co.ok) throw new Error('checkout failed');
      refs.push(co.reference);
    }
    const results = await Promise.all(refs.map((ref, i) =>
      db.q<{ r: { outcome: string; unapplied_kobo: number } }>(service,
        `select public.server_post_verified_payment('test-fake', $1, $2, 500000, 'NGN', now(), null, 'test') r`, [`FAKE-M${i}`, ref])));
    expect(results.every(([x]) => x.r.outcome === 'recorded')).toBe(true);
    const [s] = await db.q<Record<string, string>>(owner, `select
      (select sum(amount_kobo) from public.payments where member_id = $1) received,
      (select sum(amount_kobo) from public.allocations where charge_id = $2) allocated`, [MEMBER.C, welfare]);
    expect(Number(s.received)).toBe(6 * 500_000);
    expect(Number(s.allocated)).toBe(500_000);
    expect((await balances('C')).credit).toBe(5 * 500_000);
    const [rep] = await db.q<{ r: { checks: { ok: boolean }[] } }>(officer(db), 'select public.collection_report() r');
    expect(rep.r.checks.every((x) => x.ok)).toBe(true);
  });

  it('dues paid by another payment leave the earlier pending one unresolved, then credit if it confirms', async () => {
    const annual = await chargeId('A', 'Annual dues');
    const first = await checkout('A', [annual]);
    if (!first.ok) throw new Error('checkout failed');
    fake.settle(first.reference, { status: 'pending', paidAt: null });
    await reconcileAttempts({ serviceRpc: pgRpc(db, service), providers: providers(), olderThanSeconds: 0 });
    const second = await checkout('A', [annual]);
    if (!second.ok) throw new Error('checkout failed');
    fake.settle(second.reference, { status: 'success' });
    await deliverWebhook(second.reference);
    await process();

    const [att] = await db.q<{ status: string; charges_paid_elsewhere: boolean }>(member(db, 'A'),
      'select status, charges_paid_elsewhere from public.payment_attempt_overview where reference = $1', [first.reference]);
    expect(att).toEqual({ status: 'pending', charges_paid_elsewhere: true });
    const [cb] = await db.q<{ status: string; has_pending_attempt: boolean }>(member(db, 'A'), 'select status, has_pending_attempt from public.charge_balances where id = $1', [annual]);
    expect(cb).toEqual({ status: 'paid', has_pending_attempt: true });

    fake.settle(first.reference, { status: 'success' });
    await deliverWebhook(first.reference);
    await process();
    expect((await balances('A')).credit).toBe(1_500_000);
  });
});

describe('interrupted processing', () => {
  it('a worker that stops after verifying leaves no partial records; the next run finishes once', async () => {
    const co = await checkout('A', [await chargeId('A', 'Annual dues')]);
    if (!co.ok) throw new Error('checkout failed');
    fake.settle(co.reference, { status: 'success' });
    await deliverWebhook(co.reference);
    const before = await counts();
    await process({ stopAfterVerify: true, leaseSeconds: 1 });
    expect(await counts()).toEqual(before);
    expect((await process()).claimed).toBe(0); // still leased
    await new Promise((r) => setTimeout(r, 1200));
    expect((await process()).recorded).toBe(1);
    expect((await counts()).payments).toBe(before.payments + 1);
  });

  it('a failure part-way through posting rolls back everything; a retry posts once', async () => {
    // Test-only fault: fail when the receipt is written, after payment and allocations.
    await db.pool.query(`create table app.test_fault (active boolean not null);
      insert into app.test_fault values (true);
      create function app.test_fault() returns trigger language plpgsql as $$
      begin if exists (select 1 from app.test_fault where active) then raise exception 'injected fault'; end if; return new; end $$;
      create trigger test_fault before insert on public.receipts for each row execute function app.test_fault();`);
    const co = await checkout('A', [await chargeId('A', 'Annual dues')]);
    if (!co.ok) throw new Error('checkout failed');
    fake.settle(co.reference, { status: 'success' });
    await deliverWebhook(co.reference);
    const before = await counts();
    expect((await process()).retried).toBe(1);
    expect(await counts()).toEqual(before);
    const [att] = await db.q<{ status: string }>(owner, 'select status from public.payment_attempts where reference = $1', [co.reference]);
    expect(att.status).toBe('started'); // the "confirmed" update rolled back too
    const [ev] = await db.q<{ last_error: string }>(owner, 'select last_error from app.provider_events');
    expect(ev.last_error).toMatch(/injected fault/);

    await db.pool.query('update app.test_fault set active = false; update app.provider_events set next_attempt_at = now();');
    expect((await process()).recorded).toBe(1);
    const after = await counts();
    expect(after.payments).toBe(before.payments + 1);
    expect(after.receipts).toBe(before.receipts + 1);
    expect(after.confirmed_events).toBe(1);
  });
});

describe('Scenario E: repeated assessments', () => {
  it('a second run creates nothing', async () => {
    const [r1] = await db.q<{ r: { created: number } }>(officer(db), 'select public.run_recurring_assessment() r');
    expect(r1.r.created).toBe(4); // December meeting contribution: A, B, C, D
    const [r2] = await db.q<{ r: { created: number; already_assessed: number } }>(officer(db), 'select public.run_recurring_assessment() r');
    expect(r2.r).toMatchObject({ created: 0, already_assessed: 7 });
  });

  it('a levy targets only selected members and queues one notice each', async () => {
    const [l] = await db.q<{ id: string }>(officer(db),
      `select public.publish_levy('Hall repair levy', 300000, '2026-11-24', '2026-12-15', array[$1, $2]::uuid[]) id`, [MEMBER.A, MEMBER.D]);
    const charges = await db.q<{ member_id: string }>(owner, 'select member_id from public.charges where levy_id = $1 order by member_id', [l.id]);
    expect(charges.map((c) => c.member_id)).toEqual([MEMBER.A, MEMBER.D]);
    const notices = await db.q(owner, `select 1 from public.outbox_messages o join public.charges c on c.id = o.charge_id where c.levy_id = $1 and o.kind = 'new-charge'`, [l.id]);
    expect(notices).toHaveLength(2);
  });
});

describe('Scenario F: reminders', () => {
  it('reruns add nothing, paid dues are excluded and stale stages are superseded', async () => {
    const [j1] = await db.q<{ r: { queued: number } }>(officer(db), 'select public.run_reminder_job() r');
    expect(j1.r.queued).toBeGreaterThan(0);
    const [j2] = await db.q<{ r: { queued: number } }>(officer(db), 'select public.run_reminder_job() r');
    expect(j2.r.queued).toBe(0);

    await db.pool.query(`update app.settings set clock_override = '2026-12-02 10:00 Africa/Lagos'`);
    await db.q(officer(db), 'select public.run_reminder_job()');
    await db.q(officer(db), 'select public.deliver_reminder_previews()');
    const levy = await chargeId('A', 'Community project levy');
    const msgs = await db.q<{ kind: string; status: string; status_reason: string; body: string }>(owner,
      `select kind, status, status_reason, body from public.outbox_messages where charge_id = $1 and kind <> 'new-charge' order by created_at`, [levy]);
    expect(msgs.map((m) => [m.kind, m.status])).toEqual([['reminder-due-soon', 'cancelled'], ['reminder-overdue', 'previewed']]);
    expect(msgs[0].status_reason).toBe('Superseded: the charge is now overdue');
    expect(msgs[1].body).toBe('Hello Member A, Community project levy (₦10,000) was due on 30 November and is still open. You can pay it in Community Ledger.');
  });
});

describe('analytics events written by the database', () => {
  it('carry only allowlisted properties and the opaque analytics id', async () => {
    const co = await checkout('A', [await chargeId('A', 'Annual dues')]);
    if (!co.ok) throw new Error('checkout failed');
    fake.settle(co.reference, { status: 'success' });
    await deliverWebhook(co.reference);
    await process();
    const rows = await db.q<{ event: string; distinct_id: string; properties: Record<string, unknown> }>(owner, 'select event, distinct_id, properties from app.analytics_outbox order by event');
    expect(rows.map((r) => r.event)).toEqual(['payment confirmed', 'payment started']);
    for (const r of rows) {
      expect(r.distinct_id).toBe('an_7f3a91c2d84e51be');
      expect(Object.keys(r.properties).sort()).toEqual(['$process_person_profile', 'environment', 'is_demo', 'schema_version', 'surface']);
      const text = JSON.stringify(r);
      for (const banned of ['Member A', 'member-a@', '15000', '1500000', co.reference, 'FAKE-']) expect(text).not.toContain(banned);
    }
  });
});

describe('verification answers about a different reference', () => {
  async function mismatchTasks() {
    return db.q<{ key: string; member_id: string; title: string; status: string }>(owner,
      `select key, member_id, title, status from public.tasks where key like 'mismatch:%'`);
  }

  it('webhook processing records one officer task, credits nothing, and retries add no duplicate', async () => {
    const co = await checkout('A', [await chargeId('A', 'Annual dues')]);
    if (!co.ok) throw new Error('checkout failed');
    fake.settle(co.reference, { status: 'success', reference: 'CL-SOMEONEELSE', providerRef: 'FAKE-OTHER-1' });
    const before = await counts();
    await deliverWebhook(co.reference);
    expect((await process()).held).toBe(1);
    // Retries through every path: a second event, reconciliation and the same event again.
    await deliverWebhook(co.reference, 'charge.success.retry');
    await process();
    await reconcileAttempts({ serviceRpc: pgRpc(db, service), providers: providers(), olderThanSeconds: 0 });
    await db.pool.query(`update app.provider_events set status = 'received', next_attempt_at = now()`);
    await process();

    expect(await counts()).toEqual(before);
    expect((await balances('A')).outstanding).toBe(3_000_000);
    const tasks = await mismatchTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ member_id: MEMBER.A, status: 'open', title: 'Payment check returned a different reference' });
    const officerView = await db.q<{ detail: string }>(officer(db), `select detail from public.tasks where key like 'mismatch:%'`);
    expect(officerView).toHaveLength(1);
    expect(officerView[0].detail).toContain(co.reference);
    expect(officerView[0].detail).toContain('Nothing was credited');
    expect(await db.q(member(db, 'A'), `select 1 from public.tasks`)).toEqual([]); // members never see tasks
    const audits = await db.q(owner, `select 1 from public.audit_events where action = 'Payment held' and detail like $1`, [`%${co.reference}%`]);
    expect(audits).toHaveLength(1);
  });
});
