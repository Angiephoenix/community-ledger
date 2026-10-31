// Edge Function: provider webhook receiver.
// Deno entry point. NOT run or type-checked in the build environment (no Deno);
// _shared/webhook.ts and _shared/process.ts are covered by the Node test suite.
// Deploy without Supabase JWT verification: the provider cannot send a
// Supabase JWT. Authenticity comes from the provider's signature check.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { requireEnv } from '../_shared/http.ts';
import { processProviderEvents } from '../_shared/process.ts';
import { providersFromEnv } from '../_shared/providers/index.ts';
import { supabaseRpc } from '../_shared/supabaseRpc.ts';
import { receiveWebhook } from '../_shared/webhook.ts';

const env = (k: string) => Deno.env.get(k);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const rawBody = await req.text();
  const serviceRpc = supabaseRpc(createClient(requireEnv(env, 'SUPABASE_URL'), requireEnv(env, 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } }));
  const providers = providersFromEnv(env);
  const provider = providers[env('PAYMENT_PROVIDER') ?? 'paystack'];
  const result = await receiveWebhook({ rawBody, headers: req.headers, provider, serviceRpc });
  if (result.status === 200 && result.isNew) {
    // Recorded durably already. Try to process now; the scheduled job retries anything left.
    await processProviderEvents({ serviceRpc, providers, limit: 5 }).catch(() => {});
  }
  return new Response(result.body, { status: result.status });
});
