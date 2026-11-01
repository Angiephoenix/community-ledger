import { applyVerifiedTransaction } from './process.ts';
import { ProviderUnavailableError, type PaymentProvider, type Rpc } from './types.ts';

export type ReturnStatus = 'confirmed' | 'pending' | 'failed' | 'abandoned' | 'started' | 'held' | 'checking-unavailable' | 'not-found';

/**
 * A member came back from the hosted checkout. The redirect itself proves
 * nothing, so the server asks the provider directly. Only a verified success
 * can credit the payment, through the same transaction as the webhook path.
 * The attempt must belong to the signed-in member (checked with their JWT).
 */
export async function checkReturnedPayment(deps: {
  memberRpc: Rpc;
  serviceRpc: Rpc;
  provider: PaymentProvider;
  reference: string;
}): Promise<{ status: ReturnStatus }> {
  if (!/^[A-Za-z0-9-]{6,64}$/.test(deps.reference)) return { status: 'not-found' };
  const mine = await deps.memberRpc.call<{ status: string } | null>('my_payment_attempt', { p_reference: deps.reference });
  if (!mine) return { status: 'not-found' };
  if (mine.status === 'confirmed') return { status: 'confirmed' };
  try {
    const tx = await deps.provider.verifyTransaction(deps.reference);
    const outcome = await applyVerifiedTransaction(deps.serviceRpc, deps.provider, deps.reference, tx, 'return');
    if (outcome === 'recorded' || outcome === 'duplicate-ignored') return { status: 'confirmed' };
    if (outcome === 'held') return { status: 'held' };
  } catch (e) {
    if (e instanceof ProviderUnavailableError) return { status: 'checking-unavailable' };
    throw e;
  }
  const after = await deps.memberRpc.call<{ status: ReturnStatus } | null>('my_payment_attempt', { p_reference: deps.reference });
  return { status: after?.status ?? 'not-found' };
}
