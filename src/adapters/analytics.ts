// Analytics adapters.
// - Demo mode: local only. Events stay in this browser for the inspector.
// - Connected test system: explicit events posted to PostHog's capture
//   endpoint with a payload built here from the allowlist. No PostHog SDK is
//   loaded, so there is no autocapture, session replay, surveys, heatmaps or
//   automatic URL/referrer/device properties to switch off.

export const ANALYTICS_SCHEMA_VERSION = 1;

export type AnalyticsEventName =
  | 'statement viewed'
  | 'payment started'
  | 'payment confirmed'
  | 'receipt viewed'
  | 'discrepancy reported';

export type Surface = 'member' | 'officer' | 'processing (simulated server)' | 'server';
export type ErrorCategory = 'none' | 'validation' | 'payment-failed' | 'payment-pending';

/** The only properties that may leave the app. No names, amounts, references or free text. */
export interface AnalyticsProperties {
  schema_version: number;
  environment: 'demo' | 'test';
  is_demo: boolean;
  surface: Surface;
  error_category?: ErrorCategory;
}

export interface CapturedEvent {
  id: number;
  name: AnalyticsEventName;
  /** Opaque per-member id, pseudonymous rather than anonymous. */
  distinctId: string;
  properties: AnalyticsProperties;
  capturedAt: string;
  destination: 'local only' | 'posthog (test project)';
}

export interface AnalyticsAdapter {
  capture(name: AnalyticsEventName, distinctId: string, props: { surface: Surface; error_category?: ErrorCategory }): void;
}

const ALLOWED_KEYS = new Set<keyof AnalyticsProperties>(['schema_version', 'environment', 'is_demo', 'surface', 'error_category']);

/** Drops anything outside the allowlist, whatever a caller passes in. */
export function sanitize(props: Record<string, unknown>, environment: 'demo' | 'test' = 'demo'): AnalyticsProperties {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (ALLOWED_KEYS.has(k as keyof AnalyticsProperties)) out[k] = v;
  }
  return {
    ...(out as Partial<AnalyticsProperties>),
    schema_version: ANALYTICS_SCHEMA_VERSION,
    environment,
    is_demo: environment === 'demo',
  } as AnalyticsProperties;
}

/** The exact JSON body sent to PostHog's single-event capture endpoint. */
export function buildCapturePayload(input: {
  apiKey: string;
  name: AnalyticsEventName;
  distinctId: string;
  props: Record<string, unknown>;
  uuid: string;
  timestamp: string;
}) {
  return {
    api_key: input.apiKey,
    event: input.name,
    distinct_id: input.distinctId,
    uuid: input.uuid,
    timestamp: input.timestamp,
    // No person profile is created or updated for these events.
    properties: { ...sanitize(input.props, 'test'), $process_person_profile: false },
  };
}

/**
 * Connected test system: posts explicit events to a PostHog test project.
 * Failures are swallowed: analytics must never interrupt payments or views.
 * Every outbound payload (with the key redacted) is kept for local inspection.
 */
export function createPostHogCaptureAdapter(config: {
  host: string;
  apiKey: string;
  fetch?: typeof fetch;
  clock?: () => string;
  limit?: number;
}) {
  const local = createLocalAnalytics(config.clock ?? (() => new Date().toISOString()), config.limit);
  const outbound: unknown[] = [];
  const doFetch = config.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  return {
    ...local,
    outbound: () => outbound,
    capture(name: AnalyticsEventName, distinctId: string, props: { surface: Surface; error_category?: ErrorCategory }) {
      try {
        const payload = buildCapturePayload({
          apiKey: config.apiKey,
          name,
          distinctId,
          props,
          uuid: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
        });
        outbound.unshift({ ...payload, api_key: '[redacted]' });
        local.record(name, distinctId, payload.properties, 'posthog (test project)');
        void doFetch(`${config.host.replace(/\/$/, '')}/i/v0/e/`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
        }).catch(() => {});
      } catch {
        /* ignored on purpose */
      }
    },
  };
}

type Listener = () => void;

export function createLocalAnalytics(clock: () => string, limit = 100) {
  let events: CapturedEvent[] = [];
  let counter = 0;
  const listeners = new Set<Listener>();
  const adapter: AnalyticsAdapter & {
    record: (name: AnalyticsEventName, distinctId: string, properties: object, destination: CapturedEvent['destination']) => void;
    events: () => CapturedEvent[];
    subscribe: (l: Listener) => () => void;
    clear: () => void;
  } = {
    capture(name, distinctId, props) {
      // Analytics must never interrupt a payment or change a balance.
      try {
        adapter.record(name, distinctId, sanitize(props), 'local only');
      } catch {
        /* ignored on purpose */
      }
    },
    record(name, distinctId, properties, destination) {
      counter += 1;
      events = [{ id: counter, name, distinctId, properties: properties as AnalyticsProperties, capturedAt: clock(), destination }, ...events].slice(0, limit);
      listeners.forEach((l) => l());
    },
    events: () => events,
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    clear() {
      events = [];
      listeners.forEach((l) => l());
    },
  };
  return adapter;
}
