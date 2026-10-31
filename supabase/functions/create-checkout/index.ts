// Edge Function: start a hosted checkout for the signed-in member.
// Deno entry point. NOT run or type-checked in the build environment (no Deno);
// the logic it calls (_shared/checkout.ts) is covered by the Node test suite.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { createCheckout } from '../_shared/checkout.ts';
import { corsHeaders, json, requireEnv } from '../_shared/http.ts';
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
    const asMember = createClient(url, requireEnv(env, 'SUPABASE_ANON_KEY'), { global: { headers: { authorization } }, auth: { persistSession: false } });
    const { data: userData, error: userError } = await asMember.auth.getUser(authorization.replace(/^Bearer\s+/i, ''));
    if (userError || !userData.user?.email) return json({ error: 'Please sign in again.' }, 401, cors);
    const asServer = createClient(url, requireEnv(env, 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } });
    const providers = providersFromEnv(env);
    const providerId = env('PAYMENT_PROVIDER') ?? 'paystack';
    const body = (await req.json().catch(() => ({}))) as { chargeIds?: string[] };
    const result = await createCheckout({
      memberRpc: supabaseRpc(asMember),
      serviceRpc: supabaseRpc(asServer),
      provider: providers[providerId],
      email: userData.user.email,
      chargeIds: body.chargeIds ?? [],
      callbackUrl: `${requireEnv(env, 'APP_ORIGIN')}/?payment=return`,
    });
    return json(result, result.ok ? 200 : 503, cors);
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unexpected error';
    // Validation messages from the database are safe to show; others are generic.
    return json({ ok: false, code: 'error', message: /already paid|own charges|Choose at least|Sign in/.test(message) ? message : 'Something went wrong. Nothing was charged.' }, 400, cors);
  }
});
