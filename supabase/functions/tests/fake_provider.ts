import { hmacHex, safeEqualHex } from '../_shared/crypto.ts';
import { ProviderUnavailableError, type PaymentProvider, type VerifiedTransaction } from '../_shared/types.ts';

/**
 * TEST DOUBLE. A fake payment provider for automated tests only. It is not
 * Paystack and says nothing about how Paystack behaves. It signs webhooks
 * with HMAC-SHA512 over the raw body using a test secret.
 */
export class FakeProvider implements PaymentProvider {
  readonly id = 'test-fake';
  readonly label = 'Fake provider (tests only)';
  readonly secret = 'fake-provider-test-secret';
  transactions = new Map<string, VerifiedTransaction>();
  checkouts: { reference: string; amountKobo: number; email: string }[] = [];
  down = false;
  verifyCalls = 0;
  private seq = 0;

  async initializeCheckout(input: { reference: string; amountKobo: number; currency: string; email: string; callbackUrl: string }) {
    if (this.down) throw new ProviderUnavailableError('fake outage');
    this.checkouts.push({ reference: input.reference, amountKobo: input.amountKobo, email: input.email });
    this.transactions.set(input.reference, {
      status: 'ongoing', reference: input.reference, amountKobo: input.amountKobo, currency: input.currency,
      environment: 'test', providerRef: `FAKE-${++this.seq}`, transactionId: String(this.seq), paidAt: null,
    });
    return { authorizationUrl: `https://checkout.fake.test/${input.reference}` };
  }

  /** The customer completes (or fails) payment on the hosted page. */
  settle(reference: string, patch: Partial<VerifiedTransaction>) {
    const tx = this.transactions.get(reference);
    if (!tx) throw new Error(`no fake transaction ${reference}`);
    this.transactions.set(reference, { ...tx, paidAt: new Date().toISOString(), ...patch });
  }

  async verifyTransaction(reference: string): Promise<VerifiedTransaction> {
    this.verifyCalls++;
    if (this.down) throw new ProviderUnavailableError('fake outage');
    const tx = this.transactions.get(reference);
    if (!tx) return { status: 'not-found', reference, amountKobo: 0, currency: 'NGN', environment: 'test', providerRef: '', transactionId: null, paidAt: null };
    return { ...tx };
  }

  async webhook(reference: string, event = 'charge.success'): Promise<{ rawBody: string; headers: Headers }> {
    const tx = this.transactions.get(reference);
    const rawBody = JSON.stringify({ event, data: { reference, id: tx?.transactionId, amount: tx?.amountKobo, currency: tx?.currency } });
    return { rawBody, headers: new Headers({ 'x-fake-signature': await hmacHex('SHA-512', this.secret, rawBody) }) };
  }

  async verifyWebhookSignature(rawBody: string, headers: Headers) {
    const sig = headers.get('x-fake-signature') ?? '';
    return safeEqualHex(sig, await hmacHex('SHA-512', this.secret, rawBody));
  }

  parseWebhook(rawBody: string) {
    try {
      const b = JSON.parse(rawBody) as { event: string; data: { reference?: string; id?: string } };
      return { dedupeKey: `${b.event}:${b.data.id ?? b.data.reference}`, eventType: b.event, reference: b.data.reference ?? null };
    } catch {
      return null;
    }
  }

  isPaymentEvent(eventType: string) {
    return eventType.startsWith('charge.');
  }
}
