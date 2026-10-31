// Edge Function: scheduled worker. Processes recorded provider events,
// reconciles attempts whose confirmation never arrived, and sends queued
// analytics events. Call it on a schedule with the CRON_SECRET header.
// Deno entry point. NOT run or type-checked in the build environment (no Deno);
// the modules it calls are covered by the Node test suite.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { dispatchAnalytics } from '../_shared/analytics.ts';
import { safeEqualHex } from '../_shared/crypto.ts';
import { json, requireEnv } from '../_shared/http.ts';
import { processProviderEvents, reconcileAttempts } from '../_shared/process.ts';
import { providersFromEnv } from '../_shared/providers/index.ts';
import { supabaseRpc } from '../_shared/supabaseRpc.ts';

const env = (k: string) => Deno.env.get(k);
const hex = (s: string) => [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('');

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!safeEqualHex(hex(req.headers.get('x-cron-secret') ?? ''), hex(requireEnv(env, 'CRON_SECRET')))) return json({ error: 'Forbidden' }, 403);
  const serviceRpc = supabaseRpc(createClient(requireEnv(env, 'SUPABASE_URL'), requireEnv(env, 'SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } }));
  const providers = providersFromEnv(env);
  const events = await processProviderEvents({ serviceRpc, providers });
  const reconciled = await reconcileAttempts({ serviceRpc, providers });
  const analytics = await dispatchAnalytics({ serviceRpc, fetch, host: env('POSTHOG_HOST'), apiKey: env('POSTHOG_PROJECT_KEY') })
    .catch(() => ({ status: 'failed', count: 0 }));
  return json({ events, reconciled: { checked: reconciled.checked }, analytics: { status: analytics.status, count: analytics.count } });
});
