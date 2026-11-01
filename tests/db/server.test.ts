import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createCheckout } from '../../supabase/functions/_shared/checkout.ts';
import { receiveWebhook } from '../../supabase/functions/_shared/webhook.ts';
import { processProviderEvents } from '../../supabase/functions/_shared/process.ts';
import { checkReturnedPayment } from '../../supabase/functions/_shared/paymentReturn.ts';
import { dispatchAnalytics } from '../../supabase/functions/_shared/analytics.ts';
import { createPaystackProvider } from '../../supabase/functions/_shared/providers/index.ts';
import { freshDb, member, MEMBER, owner, service, type TestDb } from './harness';
import { FakeProvider, pgRpc } from './doubles';

// Server modules shared with the Edge Functions, against a real database and
// a FAKE provider. Not evidence about Paystack.

let db: TestDb;
let fake: FakeProvider;
beforeEach(async () => {
  db = await freshDb();
  await db.pool.query(`update app.settings set payment_provider = 'test-fake'`);
  fake = new FakeProvider();
});
afterEach(async () => { await db.close(); });

async function annualA() {
  const [r] = await db.q<{ id: string }>(owner, `select id from public.charges where member_id = $1 and title like 'Annual dues%'`, [MEMBER.A]);
  return r.id;
}
async function paidCheckout() {
  const co = await createCheckout({ memberRpc: pgRpc(db, member(db, 'A')), serviceRpc: pgRpc(db, service), provider: fake,
    email: 'member-a@example.test', chargeIds: [await annualA()], callbackUrl: 'http://localhost/' });
  if (!co.ok) throw new Error('checkout failed');
  return co;
}

describe('return from hosted checkout', () => {
  it('a return before payment completes credits nothing', async () => {
    const co = await paidCheckout();
    const r = await checkReturnedPayment({ memberRpc: pgRpc(db, member(db, 'A')), serviceRpc: pgRpc(db, service), provider: fake, reference: co.reference });
    expect(r.status).toBe('pending');
    const [p] = await db.q<{ n: string }>(owner, `select count(*) n from public.payments where provider = 'test-fake'`);
    expect(Number(p.n)).toBe(0);
  });

  it('after the provider confirms, the server verifies and credits once', async () => {
    const co = await paidCheckout();
    fake.settle(co.reference, { status: 'success' });
    const rpcA = pgRpc(db, member(db, 'A'));
    expect((await checkReturnedPayment({ memberRpc: rpcA, serviceRpc: pgRpc(db, service), provider: fake, reference: co.reference })).status).toBe('confirmed');
    expect((await checkReturnedPayment({ memberRpc: rpcA, serviceRpc: pgRpc(db, service), provider: fake, reference: co.reference })).status).toBe('confirmed');
    // The webhook arriving afterwards is a duplicate.
    const { rawBody, headers } = await fake.webhook(co.reference);
    await receiveWebhook({ rawBody, headers, provider: fake, serviceRpc: pgRpc(db, service) });
    expect((await processProviderEvents({ serviceRpc: pgRpc(db, service), providers: { [fake.id]: fake } })).duplicates).toBe(1);
    const [p] = await db.q<{ n: string }>(owner, `select count(*) n from public.payments where provider = 'test-fake'`);
    expect(Number(p.n)).toBe(1);
  });

  it("Member B cannot use Member A's reference", async () => {
    const co = await paidCheckout();
    fake.settle(co.reference, { status: 'success' });
    const r = await checkReturnedPayment({ memberRpc: pgRpc(db, member(db, 'B')), serviceRpc: pgRpc(db, service), provider: fake, reference: co.reference });
    expect(r.status).toBe('not-found');
    expect(fake.verifyCalls).toBe(0);
  });

  it('a provider outage reports that checking is unavailable and credits nothing', async () => {
    const co = await paidCheckout();
    fake.settle(co.reference, { status: 'success' });
    fake.down = true;
    const r = await checkReturnedPayment({ memberRpc: pgRpc(db, member(db, 'A')), serviceRpc: pgRpc(db, service), provider: fake, reference: co.reference });
    expect(r.status).toBe('checking-unavailable');
  });
});

describe('Paystack adapter placeholder', () => {
  it('refuses to open a checkout and leaves no open attempt', async () => {
    await db.pool.query(`update app.settings set payment_provider = 'paystack'`);
    const co = await createCheckout({ memberRpc: pgRpc(db, member(db, 'A')), serviceRpc: pgRpc(db, service), provider: createPaystackProvider({}),
      email: 'member-a@example.test', chargeIds: [await annualA()], callbackUrl: 'http://localhost/' });
    expect(co).toMatchObject({ ok: false, code: 'provider-not-ready' });
    const [a] = await db.q<{ status: string }>(owner, `select status from public.payment_attempts where provider = 'paystack' and member_id = $1`, [MEMBER.A]);
    expect(a.status).toBe('abandoned');
  });

  it('rejects every webhook (no signature check has been implemented)', async () => {
    const r = await receiveWebhook({ rawBody: '{"event":"charge.success","data":{"reference":"x"}}', headers: new Headers(), provider: createPaystackProvider({}), serviceRpc: pgRpc(db, service) });
    expect(r.status).toBe(401);
  });
});

describe('server-side analytics delivery', () => {
  async function confirmOnePayment(times = 1) {
    const co = await paidCheckout();
    fake.settle(co.reference, { status: 'success' });
    for (let i = 0; i < times; i++) {
      const { rawBody, headers } = await fake.webhook(co.reference, i === 0 ? 'charge.success' : `charge.success.repeat${i}`);
      await receiveWebhook({ rawBody, headers, provider: fake, serviceRpc: pgRpc(db, service) });
      await processProviderEvents({ serviceRpc: pgRpc(db, service), providers: { [fake.id]: fake } });
    }
  }

  it('does nothing without configuration and keeps events for later', async () => {
    await confirmOnePayment();
    const r = await dispatchAnalytics({ serviceRpc: pgRpc(db, service), fetch: fetch });
    expect(r.status).toBe('not-configured');
    const [n] = await db.q<{ n: string }>(owner, `select count(*) n from app.analytics_outbox where status = 'pending'`);
    expect(Number(n.n)).toBe(2);
  });

  it('sends one "payment confirmed" per payment even when the webhook repeats', async () => {
    await confirmOnePayment(4);
    const bodies: { batch: { event: string; uuid: string; timestamp: string; distinct_id: string; properties: Record<string, unknown> }[] }[] = [];
    const ok = (async (_u: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
    const r = await dispatchAnalytics({ serviceRpc: pgRpc(db, service), fetch: ok, host: 'https://eu.i.posthog.com', apiKey: 'phc_test' });
    expect(r.status).toBe('sent');
    const events = bodies.flatMap((b) => b.batch);
    expect(events.filter((e) => e.event === 'payment confirmed')).toHaveLength(1);
    expect(events.filter((e) => e.event === 'payment started')).toHaveLength(1);
    for (const e of events) {
      expect(e.distinct_id).toBe('an_7f3a91c2d84e51be');
      expect(Object.keys(e.properties).sort()).toEqual(['$process_person_profile', 'environment', 'is_demo', 'schema_version', 'surface']);
    }
    expect(JSON.stringify(r.payload)).not.toContain('phc_test');
    expect((await dispatchAnalytics({ serviceRpc: pgRpc(db, service), fetch: ok, host: 'https://eu.i.posthog.com', apiKey: 'phc_test' })).status).toBe('idle');
  });

  it('a failed delivery retries with the same uuid and timestamp and never touches payments', async () => {
    await confirmOnePayment();
    const [before] = await db.q<{ n: string }>(owner, 'select count(*) n from public.payments');
    const failing = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    const first = await dispatchAnalytics({ serviceRpc: pgRpc(db, service), fetch: failing, host: 'https://eu.i.posthog.com', apiKey: 'k' });
    expect(first.status).toBe('failed');
    await db.pool.query(`update app.analytics_outbox set next_attempt_at = now()`);
    const seen: { uuid: string; timestamp: string }[] = [];
    const ok = (async (_u: string, init: RequestInit) => { seen.push(...JSON.parse(String(init.body)).batch); return new Response('{}'); }) as unknown as typeof fetch;
    await dispatchAnalytics({ serviceRpc: pgRpc(db, service), fetch: ok, host: 'https://eu.i.posthog.com', apiKey: 'k' });
    const firstBatch = (first.payload as { batch: { uuid: string; timestamp: string }[] }).batch;
    expect(seen.map((e) => [e.uuid, e.timestamp]).sort()).toEqual(firstBatch.map((e) => [e.uuid, e.timestamp]).sort());
    const [after] = await db.q<{ n: string }>(owner, 'select count(*) n from public.payments');
    expect(after.n).toBe(before.n);
  });

  it('a "payment confirmed" event exists only if the payment committed', async () => {
    await db.pool.query(`create table app.test_fault (active boolean not null); insert into app.test_fault values (true);
      create function app.test_fault() returns trigger language plpgsql as $$ begin if exists (select 1 from app.test_fault where active) then raise exception 'injected fault'; end if; return new; end $$;
      create trigger test_fault before insert on public.receipts for each row execute function app.test_fault();`);
    await confirmOnePayment();
    const [n] = await db.q<{ n: string }>(owner, `select count(*) n from app.analytics_outbox where event = 'payment confirmed'`);
    expect(Number(n.n)).toBe(0);
  });
});

describe('return verification about a different reference', () => {
  it('records the same durable task once and credits nothing', async () => {
    const co = await paidCheckout();
    fake.settle(co.reference, { status: 'success', reference: 'CL-NOTMINE00', providerRef: 'FAKE-OTHER-9' });
    const args = { memberRpc: pgRpc(db, member(db, 'A')), serviceRpc: pgRpc(db, service), provider: fake, reference: co.reference };
    expect((await checkReturnedPayment(args)).status).toBe('held');
    expect((await checkReturnedPayment(args)).status).toBe('held');
    const [p] = await db.q<{ n: string }>(owner, `select count(*) n from public.payments where provider = 'test-fake'`);
    expect(Number(p.n)).toBe(0);
    const tasks = await db.q<{ detail: string; member_id: string }>(owner, `select detail, member_id from public.tasks where key like 'mismatch:%'`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].member_id).toBe(MEMBER.A);
    expect(tasks[0].detail).toContain('a member returning from checkout');
  });
});

describe('Paystack adapter through the ledger pipeline (simulated Paystack HTTP)', () => {
  const KEY = 'sk_test_fictional_pipeline_000000000000';
  async function run(domain: 'test' | 'live') {
    await db.pool.query(`update app.settings set payment_provider = 'paystack'`);
    const { createHmac } = await import('node:crypto');
    const sessions = new Map<string, number>();
    const simulated = (async (url: string, init: RequestInit) => {
      const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.endsWith('/transaction/initialize')) {
        const b = JSON.parse(String(init.body));
        sessions.set(b.reference, b.amount);
        return ok({ status: true, message: 'Authorization URL created', data: { authorization_url: `https://checkout.paystack.com/${b.reference}`, access_code: 'x', reference: b.reference } });
      }
      const ref = decodeURIComponent(url.split('/').pop()!);
      return ok({ status: true, message: 'Verification successful', data: { id: 99001, domain, status: 'success', reference: ref, amount: sessions.get(ref), currency: 'NGN', paid_at: new Date().toISOString() } });
    }) as unknown as typeof fetch;
    const paystack = createPaystackProvider({ secretKey: KEY, fetch: simulated });
    const co = await createCheckout({ memberRpc: pgRpc(db, member(db, 'A')), serviceRpc: pgRpc(db, service), provider: paystack,
      email: 'member-a@example.test', chargeIds: [await annualA()], callbackUrl: 'http://localhost:5173/?payment=return' });
    if (!co.ok) throw new Error('checkout failed');
    expect(co.authorizationUrl).toBe(`https://checkout.paystack.com/${co.reference}`);
    const rawBody = JSON.stringify({ event: 'charge.success', data: { id: 99001, domain, status: 'success', reference: co.reference, amount: 1_500_000, currency: 'NGN' } });
    const headers = new Headers({ 'x-paystack-signature': createHmac('sha512', KEY).update(rawBody).digest('hex') });
    const hook = await receiveWebhook({ rawBody, headers, provider: paystack, serviceRpc: pgRpc(db, service) });
    expect(hook.status).toBe(200);
    const again = await receiveWebhook({ rawBody, headers, provider: paystack, serviceRpc: pgRpc(db, service) });
    expect(again.isNew).toBe(false);
    return processProviderEvents({ serviceRpc: pgRpc(db, service), providers: { paystack } });
  }

  it('a signed test-domain charge.success is verified and posted once', async () => {
    const s = await run('test');
    expect(s.recorded).toBe(1);
    const [p] = await db.q<{ n: string }>(owner, `select count(*) n from public.payments where provider = 'paystack' and provider_ref = '99001'`);
    expect(Number(p.n)).toBe(1);
    const [b] = await db.q<{ outstanding_kobo: string }>(member(db, 'A'), 'select outstanding_kobo from public.member_balances');
    expect(Number(b.outstanding_kobo)).toBe(1_500_000);
  });

  it('a live-domain answer is held, never credited', async () => {
    const s = await run('live');
    expect(s.held).toBe(1);
    const [p] = await db.q<{ n: string }>(owner, `select count(*) n from public.payments where provider = 'paystack' and provider_ref = '99001'`);
    expect(Number(p.n)).toBe(0);
    const t = await db.q(owner, `select 1 from public.tasks where type = 'held-event' and detail like '%test environment%'`);
    expect(t).toHaveLength(1);
  });
});
