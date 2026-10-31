import type { Rpc } from './types.ts';

/** Minimal shape of a supabase-js client's `.rpc`, so this file needs no import. */
interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

export function supabaseRpc(client: RpcClient): Rpc {
  return {
    async call<T>(fn: string, args: Record<string, unknown> = {}) {
      const { data, error } = await client.rpc(fn, args);
      if (error) {
        const e = new Error(error.message) as Error & { code?: string };
        e.code = error.code;
        throw e;
      }
      return data as T;
    },
  };
}
