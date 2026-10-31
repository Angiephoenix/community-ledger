// Shared server types. Plain TypeScript with Web-standard APIs only, so the
// same code runs in Supabase Edge Functions (Deno) and in the Node test suite.

/** Calls a database function. Production: supabase-js `.rpc`. Tests: SQL as the matching role. */
export interface Rpc {
  call<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T>;
}

export interface VerifiedTransaction {
  /** Provider's own status string, e.g. success, failed, abandoned, pending. */
  status: string;
  reference: string;
  amountKobo: number;
  currency: string;
  /** 'test' or 'live' as reported by the provider. Anything but 'test' is held. */
  environment: string;
  /** Stable unique id of this provider transaction (dedupes repeat confirmations). */
  providerRef: string;
  transactionId: string | null;
  paidAt: string | null;
}

export interface ParsedWebhook {
  dedupeKey: string;
  eventType: string;
  reference: string | null;
}

export interface PaymentProvider {
  readonly id: string;
  readonly label: string;
  initializeCheckout(input: {
    reference: string;
    amountKobo: number;
    currency: string;
    email: string;
    callbackUrl: string;
  }): Promise<{ authorizationUrl: string }>;
  /** Checks the webhook really came from the provider (signature over the raw body). */
  verifyWebhookSignature(rawBody: string, headers: Headers): Promise<boolean>;
  parseWebhook(rawBody: string): ParsedWebhook | null;
  /** Server-to-provider lookup. The only thing that can lead to a payment being credited. */
  verifyTransaction(reference: string): Promise<VerifiedTransaction>;
  /** Event types that should trigger a transaction check. */
  isPaymentEvent(eventType: string): boolean;
}

/** The provider could not be reached or answered with a server error. Safe to retry. */
export class ProviderUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderUnavailableError';
  }
}

/** A provider that has not been implemented or configured. */
export class ProviderNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNotReadyError';
  }
}
