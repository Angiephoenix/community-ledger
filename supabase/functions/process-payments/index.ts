// Edge Function: scheduled worker (provider events, reconciliation, analytics delivery).
import '@supabase/functions-js/edge-runtime.d.ts';
import { env, providers, rpcOf } from '../_shared/runtime.ts';
import { createWorkerFunction } from './handler.ts';

export default {
  fetch: createWorkerFunction({
    providers: providers(),
    serviceRpc: (ctx) => rpcOf(ctx.supabaseAdmin),
    fetch,
    posthogHost: env('POSTHOG_HOST'),
    posthogKey: env('POSTHOG_PROJECT_KEY'),
  }),
};
