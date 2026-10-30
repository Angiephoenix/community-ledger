// Local analytics adapter. Milestone 1 sends nothing anywhere: events are kept
// in this browser so they can be inspected in the demo drawer. A PostHog
// adapter can implement the same interface later.

export const ANALYTICS_SCHEMA_VERSION = 1;

export type AnalyticsEventName =
  | 'statement viewed'
  | 'payment started'
  | 'payment confirmed'
  | 'receipt viewed'
  | 'discrepancy reported';

export type Surface = 'member' | 'officer' | 'processing (simulated server)';
export type ErrorCategory = 'none' | 'validation' | 'payment-failed' | 'payment-pending';

/** The only properties that may leave the app. No names, amounts, references or free text. */
export interface AnalyticsProperties {
  schema_version: number;
  environment: 'demo';
  is_demo: true;
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
  destination: 'local only';
}

export interface AnalyticsAdapter {
  capture(name: AnalyticsEventName, distinctId: string, props: { surface: Surface; error_category?: ErrorCategory }): void;
}

const ALLOWED_KEYS = new Set<keyof AnalyticsProperties>(['schema_version', 'environment', 'is_demo', 'surface', 'error_category']);

/** Drops anything outside the allowlist, whatever a caller passes in. */
export function sanitize(props: Record<string, unknown>): AnalyticsProperties {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (ALLOWED_KEYS.has(k as keyof AnalyticsProperties)) out[k] = v;
  }
  return {
    ...(out as Partial<AnalyticsProperties>),
    schema_version: ANALYTICS_SCHEMA_VERSION,
    environment: 'demo',
    is_demo: true,
  } as AnalyticsProperties;
}

type Listener = () => void;

export function createLocalAnalytics(clock: () => string, limit = 100) {
  let events: CapturedEvent[] = [];
  let counter = 0;
  const listeners = new Set<Listener>();
  const adapter: AnalyticsAdapter & {
    events: () => CapturedEvent[];
    subscribe: (l: Listener) => () => void;
    clear: () => void;
  } = {
    capture(name, distinctId, props) {
      // Analytics must never interrupt a payment or change a balance.
      try {
        counter += 1;
        events = [
          { id: counter, name, distinctId, properties: sanitize(props), capturedAt: clock(), destination: 'local only' as const },
          ...events,
        ].slice(0, limit);
        listeners.forEach((l) => l());
      } catch {
        /* ignored on purpose */
      }
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
