import type { ProviderPaymentEvent } from '../domain/payments';
import type { PaymentAttempt } from '../domain/types';

// A small replaceable boundary for the payment provider. Milestone 1 only has
// the simulator below. It is not Paystack test mode and not a real webhook.
// In the connected version the confirmation event must come from a server that
// verifies the provider signature and re-checks the transaction; a browser
// success callback is never proof of payment.

export type SimulatedOutcome = 'success' | 'pending' | 'failed';

export interface PaymentProvider {
  readonly label: string;
  readonly isSimulation: boolean;
  /** Builds the confirmation the provider would send for this attempt. */
  confirmationFor(attempt: PaymentAttempt, outcome: 'success' | 'failed'): ProviderPaymentEvent;
}

export function createPaymentSimulator(): PaymentProvider {
  // Unique per confirmation, even across page reloads.
  const nextRef = (attempt: PaymentAttempt) =>
    `SIM-TX-${attempt.id.slice(4)}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
  return {
    label: 'Payment simulator',
    isSimulation: true,
    confirmationFor(attempt, outcome) {
      return {
        providerRef: nextRef(attempt),
        attemptReference: attempt.reference,
        amountKobo: attempt.amountKobo,
        currency: attempt.currency,
        status: outcome,
      };
    },
  };
}
