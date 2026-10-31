import { ProviderNotReadyError, type PaymentProvider } from '../types.ts';

/**
 * Paystack adapter: deliberately not implemented yet.
 *
 * The milestone requires reading Paystack's current official documentation
 * before implementing initialise, verify and webhook-signature handling.
 * paystack.com could not be reached from the build environment, so this
 * adapter refuses to run instead of guessing. Checkout shows "Online payments
 * are not set up yet. Nothing was charged." and no attempt is left open.
 */
export function createPaystackProvider(_config: { secretKey?: string }): PaymentProvider {
  const notReady = () => {
    throw new ProviderNotReadyError('Paystack adapter not implemented: official documentation has not been reviewed yet.');
  };
  return {
    id: 'paystack',
    label: 'Paystack (not implemented)',
    initializeCheckout: async () => notReady(),
    verifyWebhookSignature: async () => false,
    parseWebhook: () => null,
    verifyTransaction: async () => notReady(),
    isPaymentEvent: () => false,
  };
}
