import { withSupabase, type SupabaseContext } from '@supabase/server';
import { dispatchAnalytics } from '../_shared/analytics.ts';
import { json } from '../_shared/http.ts';
import { countOutcomes, processProviderEvents, reconcileAttempts } from '../_shared/process.ts';
import type { PaymentProvider, Rpc } from '../_shared/types.ts';

export interface WorkerFunctionOptions {
  providers: Record<string, PaymentProvider>;
  serviceRpc(ctx: SupabaseContext): Rpc;
  fetch: typeof fetch;
  posthogHost?: string;
  posthogKey?: string;
}

/**
 * Scheduled worker. Only the project secret key named "cron", sent in the
 * `apikey` header, is accepted (`auth: 'secret:cron'`). Other secret keys,
 * user JWTs and anonymous requests are rejected before the handler runs.
 */
export function createWorkerFunction(o: WorkerFunctionOptions) {
  return withSupabase({ auth: 'secret:cron', cors: 'disabled' }, async (req, ctx) => {
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const serviceRpc = o.serviceRpc(ctx);
    const events = await processProviderEvents({ serviceRpc, providers: o.providers });
    const reconciled = await reconcileAttempts({ serviceRpc, providers: o.providers });
    const analytics = await dispatchAnalytics({ serviceRpc, fetch: o.fetch, host: o.posthogHost, apiKey: o.posthogKey }).catch(() => ({
      status: 'failed' as const,
      count: 0,
    }));
    return json({ events, reconciled: { checked: reconciled.checked, outcomes: countOutcomes(reconciled.outcomes) }, analytics: { status: analytics.status, count: analytics.count } });
  });
}
