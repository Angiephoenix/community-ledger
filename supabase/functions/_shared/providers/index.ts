import type { PaymentProvider } from '../types.ts';
import { createPaystackProvider } from './paystack.ts';

export { createPaystackProvider };

/** Providers available to the server, keyed by the id stored on each attempt. */
export function providersFromEnv(get: (k: string) => string | undefined): Record<string, PaymentProvider> {
  return { paystack: createPaystackProvider({ secretKey: get('PAYSTACK_SECRET_KEY') }) };
}
