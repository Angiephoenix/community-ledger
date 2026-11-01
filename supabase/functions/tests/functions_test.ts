// Deno tests for the Edge Function HTTP handlers, exercising the real
// @supabase/server auth gate with test-only keys, against a throwaway
// PostgreSQL database prepared by tests/db/functions.test.ts.
//
// What this covers: request handling, auth decisions, status codes, timing of
// the webhook acknowledgement. What it cannot cover: the Supabase platform
// gateway (`verify_jwt` in config.toml), which only runs on Supabase.

import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1.0.13';
import pg from 'npm:pg@8.23.1';
import { FakeProvider } from './fake_provider.ts';
import type { Rpc } from '../_shared/types.ts';

// ---------------------------------------------------------------- test-only keys (fictional)

const SUPABASE_URL = 'http://127.0.0.1:54399';
const KEYS = { default: 'sb_secret_test_default_0000', cron: 'sb_secret_test_cron_1111' };
const kid = 'test-key-1';
const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const publicJwk = { ...(await crypto.subtle.exportKey('jwk', signing.publicKey)), kid, alg: 'ES256', use: 'sig' };
const otherKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);

Deno.env.set('SUPABASE_URL', SUPABASE_URL);
Deno.env.set('SUPABASE_PUBLISHABLE_KEYS', JSON.stringify({ default: 'sb_publishable_test_0000' }));
Deno.env.set('SUPABASE_SECRET_KEYS', JSON.stringify(KEYS));
Deno.env.set('SUPABASE_JWKS', JSON.stringify({ keys: [publicJwk] }));

const b64url = (data: Uint8Array | string) =>
  btoa(typeof data === 'string' ? data : String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function jwt(sub: string, opts: { email?: string; iss?: string; key?: CryptoKey; exp?: number } = {}) {
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({
    sub, role: 'authenticated', aud: 'authenticated', email: opts.email ?? 'member@example.test',
    iss: opts.iss ?? `${SUPABASE_URL}/auth/v1`, iat: now, exp: opts.exp ?? now + 600,
  }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, opts.key ?? signing.privateKey, new TextEncoder().encode(`${header}.${payload}`)));
  return `${header}.${payload}.${b64url(sig)}`;
}

// ---------------------------------------------------------------- database access

const users = JSON.parse(Deno.env.get('CL_USERS')!) as { A: string; B: string; officer: string };
const pool = new pg.Pool({ host: '127.0.0.1', port: Number(Deno.env.get('CL_PG_PORT')), user: 'postgres', database: Deno.env.get('CL_PG_DB'), max: 6 });
await pool.query(`update app.settings set payment_provider = 'test-fake'`);

type Who = { kind: 'service' } | { kind: 'user'; userId: string };
function pgRpc(who: Who): Rpc {
  return {
    async call<T>(fn: string, args: Record<string, unknown> = {}) {
      const c = await pool.connect();
      try {
        await c.query('begin');
        const claims = who.kind === 'service' ? { role: 'service_role' } : { sub: who.userId, role: 'authenticated' };
        await c.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
        await c.query(`set local role ${who.kind === 'service' ? 'service_role' : 'authenticated'}`);
        const keys = Object.keys(args);
        const r = await c.query(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]));
        await c.query('commit');
        return r.rows[0]?.r as T;
      } catch (e) {
        await c.query('rollback').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    },
  };
}
const service = pgRpc({ kind: 'service' });
const count = async (sql: string, params: unknown[] = []) => Number((await pool.query(sql, params)).rows[0].n);
const chargeOf = async (title: string) =>
  (await pool.query(`select id from public.charges where member_id = '00000000-0000-4000-8000-00000000000a' and title like $1`, [`${title}%`])).rows[0].id as string;

// ---------------------------------------------------------------- the handlers under test

const { createCheckoutFunction } = await import('../create-checkout/handler.ts');
const { createReturnFunction } = await import('../payment-return/handler.ts');
const { createWebhookFunction } = await import('../payment-webhook/handler.ts');
const { createWorkerFunction } = await import('../process-payments/handler.ts');

const fake = new FakeProvider();
const APP = 'http://localhost:5173';
const memberRpcs = (ctx: { userClaims: { id: string } | null }) => ({ memberRpc: pgRpc({ kind: 'user', userId: ctx.userClaims!.id }), serviceRpc: service });
const checkout = createCheckoutFunction({ supabaseUrl: SUPABASE_URL, appOrigin: APP, provider: fake, rpcs: memberRpcs as never });
const ret = createReturnFunction({ supabaseUrl: SUPABASE_URL, appOrigin: APP, provider: fake, rpcs: memberRpcs as never });
const worker = createWorkerFunction({ providers: { [fake.id]: fake }, serviceRpc: () => service, fetch });

const post = (handler: (r: Request) => Promise<Response>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request(`${SUPABASE_URL}/functions/v1/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));

// ---------------------------------------------------------------- member endpoints

Deno.test('create-checkout rejects missing, forged, foreign-issuer and expired JWTs before the handler', async () => {
  const before = await count('select count(*) n from public.payment_attempts');
  const annual = await chargeOf('Annual');
  for (const auth of [
    undefined,
    'Bearer not-a-jwt',
    `Bearer ${await jwt(users.A, { key: otherKey.privateKey })}`,
    `Bearer ${await jwt(users.A, { iss: 'https://other-project.supabase.co/auth/v1' })}`,
    `Bearer ${await jwt(users.A, { exp: Math.floor(Date.now() / 1000) - 60 })}`,
  ]) {
    const res = await post(checkout, 'create-checkout', { chargeIds: [annual] }, auth ? { authorization: auth } : {});
    assertEquals(res.status, 401, `expected 401 for ${auth?.slice(0, 20)}`);
    await res.body?.cancel();
  }
  assertEquals(await count('select count(*) n from public.payment_attempts'), before);
});

Deno.test('create-checkout opens a hosted checkout for the signed-in member with the database amount', async () => {
  const annual = await chargeOf('Annual');
  const res = await post(checkout, 'create-checkout', { chargeIds: [annual], amount: 1 }, { authorization: `Bearer ${await jwt(users.A, { email: 'member-a@example.test' })}` });
  assertEquals(res.status, 200);
  assertEquals(res.headers.get('access-control-allow-origin'), APP);
  const body = await res.json();
  assertEquals(body.ok, true);
  assertEquals(body.amountKobo, 1_500_000); // the browser's "amount" is ignored
  assertMatch(body.authorizationUrl, /^https:\/\/checkout\.fake\.test\//);
  assertEquals(fake.checkouts.at(-1)?.email, 'member-a@example.test');
});

Deno.test("create-checkout refuses Member B paying Member A's charge", async () => {
  const annual = await chargeOf('Annual');
  const res = await post(checkout, 'create-checkout', { chargeIds: [annual] }, { authorization: `Bearer ${await jwt(users.B)}` });
  assertEquals(res.status, 400);
  assertMatch((await res.json()).message, /own charges/);
});

Deno.test('create-checkout answers CORS preflight without running the handler', async () => {
  const res = await checkout(new Request(`${SUPABASE_URL}/functions/v1/create-checkout`, { method: 'OPTIONS', headers: { origin: APP } }));
  assert(res.status === 204 || res.status === 200);
  assertEquals(res.headers.get('access-control-allow-origin'), APP);
  await res.body?.cancel();
});

Deno.test("payment-return requires a member JWT and hides other members' references", async () => {
  const annual = await chargeOf('Welfare');
  const co = await (await post(checkout, 'create-checkout', { chargeIds: [annual] }, { authorization: `Bearer ${await jwt(users.A)}` })).json();
  const anon = await post(ret, 'payment-return', { reference: co.reference });
  assertEquals(anon.status, 401);
  await anon.body?.cancel();
  const other = await post(ret, 'payment-return', { reference: co.reference }, { authorization: `Bearer ${await jwt(users.B)}` });
  assertEquals((await other.json()).status, 'not-found');
  fake.settle(co.reference, { status: 'success' });
  const mine = await post(ret, 'payment-return', { reference: co.reference }, { authorization: `Bearer ${await jwt(users.A)}` });
  assertEquals((await mine.json()).status, 'confirmed');
});

// ---------------------------------------------------------------- webhook

Deno.test('webhook acknowledges promptly after durable recording; slow processing runs afterwards', async () => {
  const annual = await chargeOf('Annual');
  const co = await (await post(checkout, 'create-checkout', { chargeIds: [annual] }, { authorization: `Bearer ${await jwt(users.A)}` })).json();
  fake.settle(co.reference, { status: 'success' });
  let backgroundStarted = false;
  let backgroundFinished = false;
  const hook = createWebhookFunction({
    provider: fake,
    providers: { [fake.id]: fake },
    serviceRpc: () => service,
    background: (task) => {
      backgroundStarted = true;
      // Simulate slow processing: 1.5 s before the real work.
      void new Promise((r) => setTimeout(r, 1500)).then(task).then(() => (backgroundFinished = true));
    },
  });
  const { rawBody, headers } = await fake.webhook(co.reference);
  const t0 = performance.now();
  const res = await hook(new Request(`${SUPABASE_URL}/functions/v1/payment-webhook`, { method: 'POST', headers, body: rawBody }));
  const elapsed = performance.now() - t0;
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assert(elapsed < 1000, `acknowledgement took ${elapsed.toFixed(0)} ms`);
  assert(backgroundStarted && !backgroundFinished, 'processing was handed off, not awaited');
  // Durable before the response: the event row exists already.
  assertEquals(await count(`select count(*) n from app.provider_events where reference = $1`, [co.reference]), 1);
  assertEquals(await count(`select count(*) n from public.payments where provider = 'test-fake' and attempt_id = (select id from public.payment_attempts where reference = $1)`, [co.reference]), 0);
  await new Promise((r) => setTimeout(r, 2500));
  assert(backgroundFinished);
  assertEquals(await count(`select count(*) n from public.payments where attempt_id = (select id from public.payment_attempts where reference = $1)`, [co.reference]), 1);
});

Deno.test('webhook returns an error, not success, when the event cannot be stored', async () => {
  let backgroundCalled = false;
  const failingStore: Rpc = { call: () => Promise.reject(new Error('database unavailable')) };
  const hook = createWebhookFunction({ provider: fake, providers: { [fake.id]: fake }, serviceRpc: () => failingStore, background: () => (backgroundCalled = true, undefined) });
  const { rawBody, headers } = await fake.webhook('CL-ANYTHING1');
  const res = await hook(new Request(`${SUPABASE_URL}/functions/v1/payment-webhook`, { method: 'POST', headers, body: rawBody }));
  assertEquals(res.status, 500);
  await res.body?.cancel();
  assertEquals(backgroundCalled, false);
});

Deno.test('webhook rejects bad signatures and repeats do not reprocess', async () => {
  let runs = 0;
  const hook = createWebhookFunction({ provider: fake, providers: { [fake.id]: fake }, serviceRpc: () => service, background: () => void runs++ });
  const { rawBody, headers } = await fake.webhook('CL-SIGTEST01');
  const bad = await hook(new Request(`${SUPABASE_URL}/functions/v1/payment-webhook`, { method: 'POST', headers: { 'x-fake-signature': '00' }, body: rawBody }));
  assertEquals(bad.status, 401);
  await bad.body?.cancel();
  assertEquals(await count(`select count(*) n from app.provider_events where reference = 'CL-SIGTEST01'`), 0);
  for (let i = 0; i < 2; i++) {
    const ok = await hook(new Request(`${SUPABASE_URL}/functions/v1/payment-webhook`, { method: 'POST', headers, body: rawBody }));
    assertEquals(ok.status, 200);
    await ok.body?.cancel();
  }
  assertEquals(runs, 1);
  assertEquals(await count(`select count(*) n from app.provider_events where reference = 'CL-SIGTEST01'`), 1);
});

Deno.test('webhook needs no Supabase credential: a signed request alone reaches the handler', async () => {
  const hook = createWebhookFunction({ provider: fake, providers: { [fake.id]: fake }, serviceRpc: () => service, background: () => {} });
  const { rawBody, headers } = await fake.webhook('CL-NOCREDS01');
  const res = await hook(new Request(`${SUPABASE_URL}/functions/v1/payment-webhook`, { method: 'POST', headers, body: rawBody }));
  assertEquals(res.status, 200);
  await res.body?.cancel();
});

// ---------------------------------------------------------------- worker

Deno.test('worker: only the "cron" secret key in the apikey header reaches the handler', async () => {
  const call = (headers: Record<string, string>) => worker(new Request(`${SUPABASE_URL}/functions/v1/process-payments`, { method: 'POST', headers }));
  const ok = await call({ apikey: KEYS.cron });
  assertEquals(ok.status, 200);
  const body = await ok.json();
  assert('events' in body && 'reconciled' in body && 'analytics' in body);
  assertEquals(body.analytics.status, 'not-configured');
  for (const [label, headers] of [
    ['no credentials', {}],
    ['wrong key', { apikey: 'sb_secret_test_cron_9999' }],
    ['the default secret key (least privilege)', { apikey: KEYS.default }],
    ['a member JWT', { authorization: `Bearer ${await jwt(users.officer)}` }],
  ] as const) {
    const res = await call(headers as Record<string, string>);
    assertEquals(res.status, 401, label);
    await res.body?.cancel();
  }
});

Deno.test({ name: 'close database pool', fn: async () => await pool.end(), sanitizeOps: false, sanitizeResources: false });
