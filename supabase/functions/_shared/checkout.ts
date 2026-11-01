import { ProviderNotReadyError, ProviderUnavailableError, type PaymentProvider, type Rpc } from './types.ts';

export interface CheckoutResult {
  ok: true;
  reference: string;
  amountKobo: number;
  authorizationUrl: string;
}
export interface CheckoutFailure {
  ok: false;
  code: 'provider-unavailable' | 'provider-not-ready' | 'invalid-request';
  message: string;
}

/**
 * Starts a hosted checkout for the signed-in member.
 * 1. The database creates the attempt from the member's own charges and its own
 *    calculated amount (`memberRpc` runs with the member's JWT, so RLS and
 *    ownership checks apply). The browser never supplies an amount.
 * 2. The provider creates a hosted payment page. We never see card details.
 * 3. The server records the checkout URL. If the provider is down, the attempt is
 *    closed as "not opened" and nothing is shown as being checked.
 */
export async function createCheckout(deps: {
  memberRpc: Rpc;
  serviceRpc: Rpc;
  provider: PaymentProvider;
  email: string;
  chargeIds: string[];
  /** The member chose to pay again after an earlier payment stayed unconfirmed. */
  payAgain?: boolean;
  callbackUrl: string;
}): Promise<CheckoutResult | CheckoutFailure> {
  if (!Array.isArray(deps.chargeIds) || deps.chargeIds.length === 0 || deps.chargeIds.some((id) => typeof id !== 'string')) {
    return { ok: false, code: 'invalid-request', message: 'Choose at least one charge to pay.' };
  }
  const attempt = await deps.memberRpc.call<{ reference: string; amount_kobo: number; currency: string }>('start_payment_attempt', {
    p_charge_ids: deps.chargeIds,
    p_pay_again: deps.payAgain === true,
  });
  try {
    const { authorizationUrl } = await deps.provider.initializeCheckout({
      reference: attempt.reference,
      amountKobo: Number(attempt.amount_kobo),
      currency: attempt.currency,
      email: deps.email,
      callbackUrl: deps.callbackUrl,
    });
    await deps.serviceRpc.call('server_record_checkout_session', { p_reference: attempt.reference, p_authorization_url: authorizationUrl });
    return { ok: true, reference: attempt.reference, amountKobo: Number(attempt.amount_kobo), authorizationUrl };
  } catch (e) {
    const reason = e instanceof Error ? e.message : 'Unknown error';
    await deps.serviceRpc.call('server_close_unopened_attempt', { p_reference: attempt.reference, p_reason: `Checkout could not be opened: ${reason}` });
    if (e instanceof ProviderNotReadyError) return { ok: false, code: 'provider-not-ready', message: 'Online payments are not set up yet. Nothing was charged.' };
    if (e instanceof ProviderUnavailableError) return { ok: false, code: 'provider-unavailable', message: 'Payments are unavailable right now. Nothing was charged. Please try again later.' };
    throw e;
  }
}
