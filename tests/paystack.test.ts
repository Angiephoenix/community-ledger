import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPaystackProvider } from '../supabase/functions/_shared/providers/paystack.ts';
import { ProviderNotReadyError, ProviderUnavailableError } from '../supabase/functions/_shared/types.ts';

// Paystack adapter against SIMULATED HTTP responses shaped by Paystack's
// OpenAPI spec and the sample webhook in Paystack's CLI. These prove our
// request building, parsing and checks. They are not a test-mode transaction.

const KEY = 'sk_test_fictional_0000000000000000000000';

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: (url: string, init: RequestInit) => { status: number; body: unknown } | Error) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = respond(url, init);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// Shape from the CLI's sample charge.success, with domain "test".
const chargeSuccess = (reference: string, amount: number, extra: Record<string, unknown> = {}) => ({
  event: 'charge.success',
  data: { id: 302961, domain: 'test', status: 'success', reference, amount, currency: 'NGN', paid_at: '2026-11-24T09:10:19.000Z', ...extra },
});

describe('Paystack adapter: keys', () => {
  it('refuses to run without a key or with anything but a test secret key, and never echoes the key', async () => {
    for (const secretKey of [undefined, '', 'sk_live_fictional_9999', 'pk_test_fictional_1111']) {
      const p = createPaystackProvider({ secretKey, fetch: fakeFetch(() => ({ status: 200, body: {} })).fn });
      const err = await p.verifyTransaction('CL-ABC12345').catch((e) => e);
      expect(err).toBeInstanceOf(ProviderNotReadyError);
      if (secretKey) expect(String(err.message)).not.toContain(secretKey);
      expect(await p.verifyWebhookSignature('{}', new Headers({ 'x-paystack-signature': 'a'.repeat(128) }))).toBe(false);
    }
  });
});

describe('Paystack adapter: initialise', () => {
  it('sends a JSON request with bearer auth, integer kobo, NGN, our reference and callback', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { status: true, message: 'Authorization URL created', data: { authorization_url: 'https://checkout.paystack.com/abc123', access_code: 'abc123', reference: 'CL-ABC12345' } } }));
    const p = createPaystackProvider({ secretKey: KEY, fetch: f.fn });
    const r = await p.initializeCheckout({ reference: 'CL-ABC12345', amountKobo: 1_500_000, currency: 'NGN', email: 'member-a@example.test', callbackUrl: 'http://localhost:5173/?payment=return' });
    expect(r.authorizationUrl).toBe('https://checkout.paystack.com/abc123');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('https://api.paystack.co/transaction/initialize');
    expect(f.calls[0].init.method).toBe('POST');
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      email: 'member-a@example.test', amount: 1_500_000, currency: 'NGN', reference: 'CL-ABC12345', callback_url: 'http://localhost:5173/?payment=return',
    });
  });

  it('treats outages, rate limits, timeouts and odd answers as unavailable; a rejected key as not ready', async () => {
    const cases: [ReturnType<typeof fakeFetch>, unknown][] = [
      [fakeFetch(() => ({ status: 503, body: {} })), ProviderUnavailableError],
      [fakeFetch(() => ({ status: 429, body: {} })), ProviderUnavailableError],
      [fakeFetch(() => Object.assign(new Error('timed out'), { name: 'TimeoutError' })), ProviderUnavailableError],
      [fakeFetch(() => ({ status: 200, body: { status: true, data: { authorization_url: 'https://x', reference: 'CL-OTHER000' } } })), ProviderUnavailableError],
      [fakeFetch(() => ({ status: 200, body: { status: true, data: { authorization_url: 'http://insecure', reference: 'CL-ABC12345' } } })), ProviderUnavailableError],
      [fakeFetch(() => ({ status: 401, body: { status: false, message: 'Invalid key' } })), ProviderNotReadyError],
    ];
    for (const [f, kind] of cases) {
      const p = createPaystackProvider({ secretKey: KEY, fetch: f.fn });
      await expect(p.initializeCheckout({ reference: 'CL-ABC12345', amountKobo: 100, currency: 'NGN', email: 'a@example.test', callbackUrl: 'x' })).rejects.toBeInstanceOf(kind as typeof Error);
    }
  });
});

describe('Paystack adapter: verify', () => {
  it('maps the verify response fields the ledger checks', async () => {
    const f = fakeFetch((url) => ({ status: 200, body: { status: true, message: 'Verification successful', data: chargeSuccess(decodeURIComponent(url.split('/').pop()!), 1_500_000).data } }));
    const p = createPaystackProvider({ secretKey: KEY, fetch: f.fn });
    const tx = await p.verifyTransaction('CL-ABC12345');
    expect(f.calls[0].url).toBe('https://api.paystack.co/transaction/verify/CL-ABC12345');
    expect(f.calls[0].init.method).toBe('GET');
    expect(tx).toEqual({
      status: 'success', reference: 'CL-ABC12345', amountKobo: 1_500_000, currency: 'NGN', environment: 'test',
      providerRef: '302961', transactionId: '302961', paidAt: '2026-11-24T09:10:19.000Z',
    });
  });

  it('reports a live-domain transaction as such, so the ledger holds it', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { status: true, data: chargeSuccess('CL-ABC12345', 100, { domain: 'live' }).data } }));
    expect((await createPaystackProvider({ secretKey: KEY, fetch: f.fn }).verifyTransaction('CL-ABC12345')).environment).toBe('live');
  });

  it('returns not-found for unknown references and refuses malformed answers', async () => {
    const nf = fakeFetch(() => ({ status: 404, body: { status: false, message: 'Transaction reference not found' } }));
    expect((await createPaystackProvider({ secretKey: KEY, fetch: nf.fn }).verifyTransaction('CL-NOPE0000')).status).toBe('not-found');
    const odd = fakeFetch(() => ({ status: 200, body: { status: true, data: { ...chargeSuccess('CL-ABC12345', 1).data, amount: '1500000' } } }));
    await expect(createPaystackProvider({ secretKey: KEY, fetch: odd.fn }).verifyTransaction('CL-ABC12345')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('Paystack adapter: webhooks', () => {
  const body = JSON.stringify(chargeSuccess('CL-ABC12345', 1_500_000));
  const sign = (raw: string, key = KEY) => createHmac('sha512', key).update(raw).digest('hex');
  const p = createPaystackProvider({ secretKey: KEY, fetch: fakeFetch(() => ({ status: 200, body: {} })).fn });

  it('accepts the signature Paystack computes over the raw body', async () => {
    expect(await p.verifyWebhookSignature(body, new Headers({ 'x-paystack-signature': sign(body) }))).toBe(true);
    expect(await p.verifyWebhookSignature(body, new Headers({ 'x-paystack-signature': sign(body).toUpperCase() }))).toBe(true);
  });

  it('rejects a tampered body, another key, a missing or malformed header', async () => {
    expect(await p.verifyWebhookSignature(body.replace('1500000', '1'), new Headers({ 'x-paystack-signature': sign(body) }))).toBe(false);
    expect(await p.verifyWebhookSignature(body, new Headers({ 'x-paystack-signature': sign(body, 'sk_test_someone_else') }))).toBe(false);
    expect(await p.verifyWebhookSignature(body, new Headers())).toBe(false);
    expect(await p.verifyWebhookSignature(body, new Headers({ 'x-paystack-signature': 'abc' }))).toBe(false);
  });

  it('parses the event and dedupes on the Paystack transaction id', () => {
    expect(p.parseWebhook(body)).toEqual({ dedupeKey: 'charge.success:302961', eventType: 'charge.success', reference: 'CL-ABC12345' });
    expect(p.parseWebhook('not json')).toBeNull();
    expect(p.parseWebhook(JSON.stringify({ event: 'charge.success' }))).toBeNull();
    expect(p.isPaymentEvent('charge.success')).toBe(true);
    expect(p.isPaymentEvent('transfer.success')).toBe(false);
  });
});
