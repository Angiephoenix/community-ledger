import { withSupabase, type SupabaseContext } from '@supabase/server';
import { processProviderEvents } from '../_shared/process.ts';
import type { PaymentProvider, Rpc } from '../_shared/types.ts';
import { receiveWebhook } from '../_shared/webhook.ts';

export interface WebhookFunctionOptions {
  provider: PaymentProvider;
  providers: Record<string, PaymentProvider>;
  serviceRpc(ctx: SupabaseContext): Rpc;
  /** Runs work after the response is sent (EdgeRuntime.waitUntil in production). */
  background(task: () => Promise<unknown>): void;
}

/**
 * Provider webhook. There is no Supabase credential to check: `auth: 'none'`
 * plus `verify_jwt = false`, and authenticity comes from the provider's
 * signature over the raw body. The response is sent as soon as the event is
 * durably stored; processing happens afterwards, never before acknowledging.
 */
export function createWebhookFunction(o: WebhookFunctionOptions) {
  return withSupabase({ auth: 'none', cors: 'disabled' }, async (req, ctx) => {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
    const rawBody = await req.text();
    const serviceRpc = o.serviceRpc(ctx);
    const result = await receiveWebhook({ rawBody, headers: req.headers, provider: o.provider, serviceRpc });
    if (result.status === 200 && result.isNew) {
      o.background(() => processProviderEvents({ serviceRpc, providers: o.providers, limit: 5 }));
    }
    return new Response(result.body, { status: result.status });
  });
}
