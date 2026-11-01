import { fromSupabaseUrl, withSupabase, type SupabaseContext } from '@supabase/server';
import { corsHeaders, json } from '../_shared/http.ts';
import { checkReturnedPayment } from '../_shared/paymentReturn.ts';
import type { PaymentProvider, Rpc } from '../_shared/types.ts';

export interface ReturnFunctionOptions {
  supabaseUrl: string;
  appOrigin: string;
  provider: PaymentProvider;
  rpcs(ctx: SupabaseContext): { memberRpc: Rpc; serviceRpc: Rpc };
}

/** Member endpoint: verify a payment with the provider after returning from checkout. */
export function createReturnFunction(o: ReturnFunctionOptions) {
  return withSupabase(
    { auth: 'user', issuer: fromSupabaseUrl(o.supabaseUrl), cors: { headers: corsHeaders(o.appOrigin) } },
    async (req, ctx) => {
      const cors = corsHeaders(o.appOrigin);
      if (req.method !== 'POST') return json({ status: 'not-found' }, 405, cors);
      const { reference } = (await req.json().catch(() => ({}))) as { reference?: unknown };
      try {
        const { memberRpc, serviceRpc } = o.rpcs(ctx);
        return json(await checkReturnedPayment({ memberRpc, serviceRpc, provider: o.provider, reference: typeof reference === 'string' ? reference : '' }), 200, cors);
      } catch {
        return json({ status: 'checking-unavailable' }, 200, cors);
      }
    },
  );
}
