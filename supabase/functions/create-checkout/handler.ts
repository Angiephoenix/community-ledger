import { fromSupabaseUrl, withSupabase, type SupabaseContext } from '@supabase/server';
import { createCheckout } from '../_shared/checkout.ts';
import { corsHeaders, json } from '../_shared/http.ts';
import type { PaymentProvider, Rpc } from '../_shared/types.ts';

export interface CheckoutFunctionOptions {
  supabaseUrl: string;
  appOrigin: string;
  provider: PaymentProvider;
  /** Database access for this request: as the signed-in member, and as the server. */
  rpcs(ctx: SupabaseContext): { memberRpc: Rpc; serviceRpc: Rpc };
}

const SAFE_MESSAGES = /already paid|own charges|Choose at least|selected twice|Unknown charge|Sign in|still being checked|has not been confirmed/;

/**
 * Member endpoint: start a hosted checkout. `auth: 'user'` verifies the
 * member's JWT (signature, `sub`, and the project as issuer) before the
 * handler runs; the platform's own JWT check stays on as well (config.toml).
 */
export function createCheckoutFunction(o: CheckoutFunctionOptions) {
  return withSupabase(
    { auth: 'user', issuer: fromSupabaseUrl(o.supabaseUrl), cors: { headers: corsHeaders(o.appOrigin) } },
    async (req, ctx) => {
      const cors = corsHeaders(o.appOrigin);
      if (req.method !== 'POST') return json({ ok: false, code: 'method-not-allowed' }, 405, cors);
      const email = ctx.userClaims?.email;
      if (!email) return json({ ok: false, code: 'no-email', message: 'Your account needs an email address to pay online.' }, 400, cors);
      const body = (await req.json().catch(() => ({}))) as { chargeIds?: unknown; payAgain?: unknown };
      const chargeIds = Array.isArray(body.chargeIds) ? body.chargeIds.filter((x): x is string => typeof x === 'string') : [];
      try {
        const { memberRpc, serviceRpc } = o.rpcs(ctx);
        const result = await createCheckout({ memberRpc, serviceRpc, provider: o.provider, email, chargeIds, payAgain: body.payAgain === true, callbackUrl: `${o.appOrigin}/?payment=return` });
        return json(result, result.ok ? 200 : result.code === 'invalid-request' ? 400 : 503, cors);
      } catch (e) {
        const message = e instanceof Error ? e.message : '';
        return json({ ok: false, code: 'error', message: SAFE_MESSAGES.test(message) ? message : 'Something went wrong. Nothing was charged.' }, 400, cors);
      }
    },
  );
}
