// Production wiring shared by the Edge Function entry points (Deno only).
import type { SupabaseClient } from '@supabase/supabase-js';
import { providersFromEnv } from './providers/index.ts';
import { supabaseRpc } from './supabaseRpc.ts';
import type { PaymentProvider, Rpc } from './types.ts';

export const env = (k: string) => Deno.env.get(k);

export function rpcOf(client: SupabaseClient): Rpc {
  return supabaseRpc(client as unknown as Parameters<typeof supabaseRpc>[0]);
}

export function providers(): Record<string, PaymentProvider> {
  return providersFromEnv(env);
}

export function activeProvider(): PaymentProvider {
  return providers()[env('PAYMENT_PROVIDER') ?? 'paystack'];
}

/**
 * Supported background execution: Supabase's Edge Runtime keeps the worker
 * alive for a promise passed to EdgeRuntime.waitUntil after the response is
 * sent. Without it, nothing runs in the background; the scheduled worker
 * processes the stored event instead.
 */
export function background(task: () => Promise<unknown>): void {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): unknown } }).EdgeRuntime;
  if (runtime?.waitUntil) runtime.waitUntil(task().catch(() => {}));
}
