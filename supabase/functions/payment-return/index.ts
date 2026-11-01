// Edge Function: a member returned from the hosted checkout.
import '@supabase/functions-js/edge-runtime.d.ts';
import { requireEnv } from '../_shared/http.ts';
import { activeProvider, env, rpcOf } from '../_shared/runtime.ts';
import { createReturnFunction } from './handler.ts';

export default {
  fetch: createReturnFunction({
    supabaseUrl: requireEnv(env, 'SUPABASE_URL'),
    appOrigin: requireEnv(env, 'APP_ORIGIN'),
    provider: activeProvider(),
    rpcs: (ctx) => ({ memberRpc: rpcOf(ctx.supabase), serviceRpc: rpcOf(ctx.supabaseAdmin) }),
  }),
};
