// Pure helpers for scripts/verify-posthog.mjs (tested in tests/posthog-check.test.ts).

export const EVENTS = ['payment started', 'payment confirmed', 'statement viewed', 'receipt viewed', 'discrepancy reported'];
export const ALLOWED = new Set(['schema_version', 'environment', 'is_demo', 'surface', 'error_category', '$process_person_profile']);
// Values that must never reach analytics, whatever PostHog adds itself.
const FORBIDDEN = [/Member [A-D]\b/, /@/, /\bCL-[A-Z0-9]{6,}/, /payment=return/, /\b\d{5,}\b/];

export const recentEventsQuery = (hours) => ({
  kind: 'HogQLQuery',
  query: `select event, distinct_id, timestamp, properties from events
          where event in (${EVENTS.map((e) => `'${e}'`).join(', ')})
            and properties.environment = 'test'
            and timestamp > now() - interval ${Number(hours)} hour
          order by timestamp limit 1000`,
});

/** rows: [event, distinct_id, timestamp, properties(object or JSON string)] */
export function analyse(rows, windowHours = 24) {
  const events = rows.map(([event, distinctId, timestamp, properties]) => ({
    event, distinctId, timestamp: new Date(timestamp).getTime(),
    properties: typeof properties === 'string' ? JSON.parse(properties) : properties ?? {},
  }));
  const counts = Object.fromEntries(EVENTS.map((e) => [e, events.filter((x) => x.event === e).length]));
  // Keys PostHog added on its side (e.g. $ip, $geoip_*): reported for inspection.
  const addedByPostHog = new Set();
  const problems = [];
  for (const e of events) {
    for (const k of Object.keys(e.properties)) {
      if (ALLOWED.has(k)) continue;
      if (k.startsWith('$')) addedByPostHog.add(k);
      else problems.push(`${e.event}: unexpected property "${k}"`);
    }
    const text = JSON.stringify({ d: e.distinctId, p: Object.fromEntries(Object.entries(e.properties).filter(([k]) => ALLOWED.has(k))) });
    for (const re of FORBIDDEN) if (re.test(text)) problems.push(`${e.event}: value matching ${re} in allowlisted data`);
    if (!/^an_/.test(e.distinctId)) problems.push(`${e.event}: distinct_id is not an opaque analytics id`);
  }
  // Funnel: payment started -> payment confirmed by the same distinct_id within the window.
  const starters = new Map();
  for (const e of events.filter((x) => x.event === 'payment started')) {
    if (!starters.has(e.distinctId) || starters.get(e.distinctId) > e.timestamp) starters.set(e.distinctId, e.timestamp);
  }
  let converted = 0;
  for (const [id, start] of starters) {
    if (events.some((x) => x.event === 'payment confirmed' && x.distinctId === id && x.timestamp >= start && x.timestamp - start <= windowHours * 3600_000)) converted++;
  }
  return { counts, funnel: { started: starters.size, confirmed: converted }, addedByPostHog: [...addedByPostHog].sort(), problems };
}

/**
 * Verdict for an analysis. Analytics is "verified" only when every required
 * event arrived, at least one payment-started -> payment-confirmed funnel
 * completed, and nothing leaked. Zero events is never verified.
 *   failed     : forbidden data, unexpected properties or non-opaque ids
 *   incomplete : required events missing or no completed funnel
 *   verified   : everything present and clean
 */
export function verdict(report, required = EVENTS) {
  const reasons = [];
  if (report.problems.length) {
    return { status: 'failed', verified: false, reasons: report.problems };
  }
  const total = Object.values(report.counts).reduce((a, b) => a + b, 0);
  if (total === 0) reasons.push('No test events were received.');
  for (const e of required) if (!report.counts[e]) reasons.push(`Missing required event: ${e}`);
  if (report.funnel.confirmed < 1) reasons.push('No completed payment started -> payment confirmed funnel.');
  return reasons.length ? { status: 'incomplete', verified: false, reasons } : { status: 'verified', verified: true, reasons: [] };
}
