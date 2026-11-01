// Edge Function: payment-provider webhook receiver.
import '@supabase/functions-js/edge-runtime.d.ts';
import { activeProvider, background, providers, rpcOf } from '../_shared/runtime.ts';
import { createWebhookFunction } from './handler.ts';

export default {
  fetch: createWebhookFunction({
    provider: activeProvider(),
    providers: providers(),
    serviceRpc: (ctx) => rpcOf(ctx.supabaseAdmin),
    background,
  }),
};
