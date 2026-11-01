import { hmacHex, safeEqualHex } from '../crypto.ts';
import {
  ProviderNotReadyError,
  ProviderUnavailableError,
  type ParsedWebhook,
  type PaymentProvider,
  type VerifiedTransaction,
} from '../types.ts';

// Paystack test-mode adapter.
//
// Sources (read 1 November 2026; paystack.com doc pages were behind a bot
// challenge, so these first-party artefacts were used instead):
// - Paystack OpenAPI spec, PaystackOSS/openapi dist/paystack.yaml: base URL
//   https://api.paystack.co, bearer auth, POST /transaction/initialize
//   (email, amount in the smallest currency unit, currency, reference with
//   only - . = and alphanumerics, callback_url) returning
//   data.authorization_url/access_code/reference; GET
//   /transaction/verify/{reference} returning data.id, domain, status,
//   reference, amount, currency, paid_at; 404 for unknown references.
// - Paystack CLI (@paystack-oss/dev-cli): webhooks carry
//   x-paystack-signature = hex HMAC-SHA512 of the request body keyed with the
//   integration's secret key; charge.success payload shape; domain test/live.
// - @paystack/paystack-sdk README: test secret keys look like sk_test_...
//
// Only a verified status of "success" can lead to a payment, and the ledger
// still checks reference, amount, currency and that domain is "test".

const BASE_URL = 'https://api.paystack.co';

interface PaystackConfig {
  secretKey?: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export function createPaystackProvider(config: PaystackConfig): PaymentProvider {
  const key = config.secretKey ?? '';
  const problem = !key
    ? 'PAYSTACK_SECRET_KEY is not set.'
    : !key.startsWith('sk_test_')
      ? 'Only a Paystack test secret key (sk_test_...) is allowed in this test system.'
      : null;
  const doFetch = config.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const base = (config.baseUrl ?? BASE_URL).replace(/\/$/, '');
  const timeoutMs = config.timeoutMs ?? 10_000;

  async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> | null }> {
    if (problem) throw new ProviderNotReadyError(problem);
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ProviderUnavailableError(`Paystack could not be reached (${(e as Error).name})`);
    }
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.status >= 500 || res.status === 429) throw new ProviderUnavailableError(`Paystack answered HTTP ${res.status}`);
    if (res.status === 401) throw new ProviderNotReadyError('Paystack rejected the secret key.');
    return { status: res.status, json };
  }

  return {
    id: 'paystack',
    label: 'Paystack (test mode)',

    async initializeCheckout(input) {
      const { status, json } = await call('POST', '/transaction/initialize', {
        email: input.email,
        amount: input.amountKobo,
        currency: input.currency,
        reference: input.reference,
        callback_url: input.callbackUrl,
      });
      const data = (json?.data ?? {}) as { authorization_url?: unknown; reference?: unknown };
      if (status !== 200 || json?.status !== true || typeof data.authorization_url !== 'string' || data.reference !== input.reference) {
        throw new ProviderUnavailableError(`Paystack did not open a checkout (HTTP ${status})`);
      }
      if (!/^https:\/\//.test(data.authorization_url)) throw new ProviderUnavailableError('Paystack returned an unexpected checkout address');
      return { authorizationUrl: data.authorization_url };
    },

    async verifyTransaction(reference): Promise<VerifiedTransaction> {
      const { status, json } = await call('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
      if (status === 404) {
        return { status: 'not-found', reference, amountKobo: 0, currency: '', environment: '', providerRef: '', transactionId: null, paidAt: null };
      }
      const d = (json?.data ?? {}) as Record<string, unknown>;
      if (status !== 200 || json?.status !== true || !Number.isSafeInteger(d.id) || !Number.isSafeInteger(d.amount) || typeof d.status !== 'string' || typeof d.reference !== 'string') {
        throw new ProviderUnavailableError(`Paystack verification returned an unexpected answer (HTTP ${status})`);
      }
      return {
        status: d.status,
        reference: d.reference,
        amountKobo: d.amount as number,
        currency: String(d.currency ?? ''),
        environment: String(d.domain ?? ''),
        providerRef: String(d.id),
        transactionId: String(d.id),
        paidAt: typeof d.paid_at === 'string' ? d.paid_at : null,
      };
    },

    async verifyWebhookSignature(rawBody, headers) {
      if (problem) return false;
      const signature = (headers.get('x-paystack-signature') ?? '').toLowerCase();
      if (!/^[0-9a-f]{128}$/.test(signature)) return false;
      return safeEqualHex(signature, await hmacHex('SHA-512', key, rawBody));
    },

    parseWebhook(rawBody): ParsedWebhook | null {
      try {
        const b = JSON.parse(rawBody) as { event?: unknown; data?: { id?: unknown; reference?: unknown } };
        if (typeof b.event !== 'string' || !b.data || typeof b.data !== 'object') return null;
        const id = b.data.id ?? b.data.reference;
        if (id == null) return null;
        return { dedupeKey: `${b.event}:${String(id)}`, eventType: b.event, reference: typeof b.data.reference === 'string' ? b.data.reference : null };
      } catch {
        return null;
      }
    },

    isPaymentEvent(eventType) {
      return eventType.startsWith('charge.');
    },
  };
}
