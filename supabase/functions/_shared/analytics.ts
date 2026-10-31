import type { Rpc } from './types.ts';

// Server-side PostHog delivery from the database's analytics outbox.
// Events are written in the same transaction as the change they describe, so
// "payment confirmed" exists only if the payment committed, and only once per
// payment (unique event key). Every retry re-sends the same uuid and timestamp
// so PostHog can deduplicate a delivery whose response was lost. Failures back
// off and retry; they never touch payments.

export const ALLOWED_PROPERTIES = new Set(['schema_version', 'environment', 'is_demo', 'surface', 'error_category', '$process_person_profile']);

export interface OutboxEvent {
  id: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  occurred_at: string;
}

/** Builds the exact batch payload. Drops any property outside the allowlist. */
export function buildBatchPayload(apiKey: string, events: OutboxEvent[]) {
  return {
    api_key: apiKey,
    batch: events.map((e) => ({
      event: e.event,
      distinct_id: e.distinct_id,
      uuid: e.id,
      timestamp: new Date(e.occurred_at).toISOString(),
      properties: Object.fromEntries(Object.entries(e.properties ?? {}).filter(([k]) => ALLOWED_PROPERTIES.has(k))),
    })),
  };
}

export async function dispatchAnalytics(deps: {
  serviceRpc: Rpc;
  fetch: typeof fetch;
  host?: string;
  apiKey?: string;
  limit?: number;
}): Promise<{ status: 'not-configured' | 'sent' | 'failed' | 'idle'; count: number; payload?: unknown }> {
  if (!deps.apiKey || !deps.host) return { status: 'not-configured', count: 0 };
  const events = await deps.serviceRpc.call<OutboxEvent[]>('server_claim_analytics_events', { p_limit: deps.limit ?? 50, p_lease_seconds: 60 });
  if (events.length === 0) return { status: 'idle', count: 0 };
  const payload = buildBatchPayload(deps.apiKey, events);
  let ok = false;
  let error = '';
  try {
    const res = await deps.fetch(`${deps.host.replace(/\/$/, '')}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    ok = res.ok;
    if (!ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = (e as Error).message;
  }
  for (const e of events) {
    await deps.serviceRpc.call('server_finish_analytics_event', { p_id: e.id, p_ok: ok, p_error: ok ? null : error });
  }
  return { status: ok ? 'sent' : 'failed', count: events.length, payload: { ...payload, api_key: '[redacted]' } };
}
