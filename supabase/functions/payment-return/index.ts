// Edge Function: a member returned from the hosted checkout.
// Deno entry point. NOT run or type-checked in the build environment (no Deno);
// _shared/paymentReturn.ts is covered by the Node test suite.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, json, requireEnv } from '../_shared/http.ts';
import { checkReturnedPayment } from '../_shared/paymentReturn.ts';
import { providersFromEnv } from '../_shared/providers/index.ts';
import { supabaseRpc } from '../_shared/supabaseRpc.ts';

const env = (k: string) => Deno.env.get(k);

Deno.serve(async (req) => {
  const cors = corsHeaders(env('APP_ORIGIN'));
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, cors);
  try {
    const url = requireEnv(env, 'SUPABASE_URL');
    const authorization = req.headers.get('authorization') ?? '';
    const memberRpc = supabaseRpc(createClient(url, requireEnv(env, 'SUPABASE_ANON_KEY'), { global: { headers: { authorization } }, auth: { persistSession: false } }));
    const serviceRpc = supabaseRpc(createClient(url, requireEnv(env, 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } }));
    const { reference } = (await req.json().catch(() => ({}))) as { reference?: string };
    const providers = providersFromEnv(env);
    const result = await checkReturnedPayment({ memberRpc, serviceRpc, provider: providers[env('PAYMENT_PROVIDER') ?? 'paystack'], reference: reference ?? '' });
    return json(result, 200, cors);
  } catch {
    return json({ status: 'checking-unavailable' }, 200, cors);
  }
});
