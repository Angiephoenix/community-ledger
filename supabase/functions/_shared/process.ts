import { ProviderNotReadyError, ProviderUnavailableError, type PaymentProvider, type Rpc, type VerifiedTransaction } from './types.ts';

export interface ProcessSummary {
  claimed: number;
  recorded: number;
  duplicates: number;
  held: number;
  statusUpdates: number;
  ignored: number;
  retried: number;
}

/**
 * Applies a provider-verified result to the ledger. Only `success` can create a
 * payment, and only through the single database transaction in
 * server_post_verified_payment (payment, allocations, receipt, reminder
 * cancellation, tasks, audit and the analytics event commit together or not at all).
 */
export async function applyVerifiedTransaction(
  serviceRpc: Rpc,
  provider: PaymentProvider,
  expectedReference: string,
  tx: VerifiedTransaction,
  source: 'processing' | 'return' = 'processing',
): Promise<'recorded' | 'duplicate-ignored' | 'held' | 'status-updated'> {
  if (tx.reference !== expectedReference) {
    // The provider answered about a different transaction. Do not credit;
    // record one durable Needs attention task for the expected attempt.
    await serviceRpc.call('server_hold_verification_mismatch', {
      p_provider: provider.id,
      p_expected_reference: expectedReference,
      p_reported_reference: tx.reference,
      p_provider_ref: tx.providerRef,
      p_source: source,
    });
    return 'held';
  }
  if (tx.status === 'success') {
    const r = await serviceRpc.call<{ outcome: 'recorded' | 'duplicate-ignored' | 'held' }>('server_post_verified_payment', {
      p_provider: provider.id,
      p_provider_ref: tx.providerRef,
      p_reference: tx.reference,
      p_amount_kobo: tx.amountKobo,
      p_currency: tx.currency,
      p_paid_at: tx.paidAt,
      p_transaction_id: tx.transactionId,
      p_environment: tx.environment,
    });
    return r.outcome;
  }
  await serviceRpc.call('server_record_provider_status', { p_reference: tx.reference, p_provider_status: tx.status });
  return 'status-updated';
}

/**
 * Processes recorded webhook events. Safe to run repeatedly and concurrently:
 * events are leased, provider outages and errors back off and retry, an event
 * left half-done by a crashed worker is picked up again when its lease expires,
 * and posting is idempotent per provider transaction.
 */
export async function processProviderEvents(deps: {
  serviceRpc: Rpc;
  providers: Record<string, PaymentProvider>;
  limit?: number;
  leaseSeconds?: number;
  /** Test hook: simulate a worker stopping after verification, before posting. */
  stopAfterVerify?: boolean;
}): Promise<ProcessSummary> {
  const summary: ProcessSummary = { claimed: 0, recorded: 0, duplicates: 0, held: 0, statusUpdates: 0, ignored: 0, retried: 0 };
  const events = await deps.serviceRpc.call<{ id: string; provider: string; event_type: string; reference: string | null }[]>(
    'server_claim_provider_events',
    { p_limit: deps.limit ?? 20, p_lease_seconds: deps.leaseSeconds ?? 120 },
  );
  summary.claimed = events.length;

  for (const ev of events) {
    const provider = deps.providers[ev.provider];
    const finish = (result: 'processed' | 'held' | 'ignored' | 'retry', note: string) =>
      deps.serviceRpc.call('server_finish_provider_event', { p_id: ev.id, p_result: result, p_note: note });
    try {
      if (!provider) {
        await finish('retry', `No provider configured for ${ev.provider}`);
        summary.retried++;
        continue;
      }
      if (!provider.isPaymentEvent(ev.event_type) || !ev.reference) {
        await finish('ignored', `Event ${ev.event_type} does not affect payments`);
        summary.ignored++;
        continue;
      }
      const tx = await provider.verifyTransaction(ev.reference);
      if (deps.stopAfterVerify) return summary; // lease stays; another run picks it up later
      const outcome = await applyVerifiedTransaction(deps.serviceRpc, provider, ev.reference, tx);
      if (outcome === 'recorded') summary.recorded++;
      else if (outcome === 'duplicate-ignored') summary.duplicates++;
      else if (outcome === 'held') summary.held++;
      else summary.statusUpdates++;
      await finish(outcome === 'held' ? 'held' : 'processed', outcome === 'status-updated' ? `Provider status ${tx.status}` : outcome);
    } catch (e) {
      const note = e instanceof ProviderUnavailableError ? `Provider unavailable: ${e.message}` : `Error: ${(e as Error).message}`;
      await finish('retry', note).catch(() => {
        /* the lease will expire and the event will be retried */
      });
      summary.retried++;
    }
  }
  return summary;
}

/**
 * Checks attempts whose confirmation never arrived (or a member returning from
 * checkout). Asks the provider directly; a redirect alone never credits money.
 */
export async function reconcileAttempts(deps: {
  serviceRpc: Rpc;
  providers: Record<string, PaymentProvider>;
  olderThanSeconds?: number;
  limit?: number;
}): Promise<{ checked: number; outcomes: string[] }> {
  const attempts = await deps.serviceRpc.call<{ reference: string; provider: string }[]>('server_attempts_to_reconcile', {
    p_older_than_seconds: deps.olderThanSeconds ?? 600,
    p_limit: deps.limit ?? 50,
  });
  const outcomes: string[] = [];
  for (const a of attempts) {
    const provider = deps.providers[a.provider];
    if (!provider) continue;
    try {
      outcomes.push(await applyVerifiedTransaction(deps.serviceRpc, provider, a.reference, await provider.verifyTransaction(a.reference)));
    } catch (e) {
      // Our own provider errors carry fixed, non-secret messages (an HTTP
      // status at most); anything else is reported only as 'error'.
      if (e instanceof ProviderUnavailableError) outcomes.push(`provider-unavailable: ${e.message}`);
      else if (e instanceof ProviderNotReadyError) outcomes.push(`provider-not-ready: ${e.message}`);
      else outcomes.push('error');
    }
  }
  return { checked: attempts.length, outcomes };
}

/** Outcome counts, e.g. { "status-updated": 1 }. Messages are our own fixed texts, never provider payloads. */
export function countOutcomes(outcomes: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const o of outcomes) out[o] = (out[o] ?? 0) + 1;
  return out;
}
