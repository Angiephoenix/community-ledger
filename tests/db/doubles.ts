import type pg from 'pg';
import type { Rpc } from '../../supabase/functions/_shared/types.ts';
import type { TestDb, Who } from './harness';

/** Calls database functions as a given role, the way supabase-js `.rpc` would. */
export function pgRpc(db: TestDb, who: Who): Rpc {
  return {
    async call<T>(fn: string, args: Record<string, unknown> = {}) {
      const keys = Object.keys(args);
      const sql = `select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`;
      return db.as(who, async (c: pg.PoolClient) => (await c.query(sql, keys.map((k) => args[k]))).rows[0]?.r as T);
    },
  };
}

// The fake provider lives with the Edge Function tests so Node and Deno share one copy.
export { FakeProvider } from '../../supabase/functions/tests/fake_provider.ts';
