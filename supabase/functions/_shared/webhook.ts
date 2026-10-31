import type { PaymentProvider, Rpc } from './types.ts';

/**
 * Webhook receiver. Order matters:
 * 1. Reject anything whose signature does not verify (nothing is stored).
 * 2. Durably record the event in the database (a repeat is a no-op).
 * 3. Only then acknowledge with 200. If recording fails, answer 500 so the
 *    provider retries later.
 * The event body is never trusted for money: processing re-verifies the
 * transaction with the provider's API before anything is credited.
 */
export async function receiveWebhook(deps: {
  rawBody: string;
  headers: Headers;
  provider: PaymentProvider;
  serviceRpc: Rpc;
}): Promise<{ status: number; body: string; eventId?: string; isNew?: boolean }> {
  let valid = false;
  try {
    valid = await deps.provider.verifyWebhookSignature(deps.rawBody, deps.headers);
  } catch {
    valid = false;
  }
  if (!valid) return { status: 401, body: 'invalid signature' };

  const parsed = deps.provider.parseWebhook(deps.rawBody);
  if (!parsed) return { status: 400, body: 'unreadable event' };

  let payload: unknown;
  try {
    payload = JSON.parse(deps.rawBody);
  } catch {
    return { status: 400, body: 'unreadable event' };
  }

  try {
    const r = await deps.serviceRpc.call<{ id: string; is_new: boolean }>('server_record_provider_event', {
      p_provider: deps.provider.id,
      p_dedupe_key: parsed.dedupeKey,
      p_event_type: parsed.eventType,
      p_reference: parsed.reference,
      p_payload: payload,
    });
    return { status: 200, body: 'ok', eventId: r.id, isNew: r.is_new };
  } catch {
    return { status: 500, body: 'not recorded; please retry' };
  }
}
