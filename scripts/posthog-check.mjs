// Pure helpers for scripts/verify-posthog.mjs (tested in tests/posthog-check.test.ts).
//
// The verdict covers the analytics checks only. It never says that milestone 2
// is complete: that also needs externally verified sign-in and access
// boundaries, a Paystack test checkout, webhook processing, balances, receipts
// and duplicate handling (docs/CONNECTED-SYSTEM.md, section 6).

export const EVENTS = ['payment started', 'payment confirmed', 'statement viewed', 'receipt viewed', 'discrepancy reported'];
export const ALLOWED = new Set(['schema_version', 'environment', 'is_demo', 'surface', 'error_category', '$process_person_profile']);

// Property names that are sensitive whatever their prefix ($ or not): network
// and location, contact details, names, URLs and paths, payment details,
// credentials and device fingerprints. Matched on name tokens, so $ip,
// ip_address, $geoip_city_name, $email, user_email, $current_url and
// payment_reference all match.
export const SENSITIVE_TOKENS = new Set([
  'ip', 'ipv4', 'ipv6', 'geoip', 'geo', 'city', 'country', 'region', 'postal', 'postcode', 'zip', 'latitude', 'longitude', 'lat', 'lng', 'location',
  'email', 'mail', 'phone', 'tel', 'telephone', 'mobile', 'msisdn', 'whatsapp',
  'name', 'firstname', 'lastname', 'surname', 'fullname', 'address',
  'url', 'uri', 'href', 'referrer', 'referer', 'pathname', 'path', 'host', 'hostname', 'domain', 'query', 'search',
  'reference', 'ref', 'amount', 'kobo', 'naira', 'card', 'last4', 'bin', 'bank', 'account', 'iban',
  'password', 'token', 'secret', 'key', 'session', 'cookie', 'authorization',
  'agent', 'useragent', 'fingerprint', 'device',
  'religion', 'religious', 'parish', 'diocese', 'note', 'message', 'text', 'comment',
]);

// Values that must never reach analytics, under any property name.
const FORBIDDEN_ANYWHERE = [/Member [A-D]\b/, /[^\s@]+@[^\s@]+\.[^\s@]+/, /\bCL-[A-Z0-9]{6,}/, /\bsk_(test|live)_/, /payment=return/, /\b\d{1,3}(\.\d{1,3}){3}\b/];
// Long digit runs (amounts, references) are checked in our own allowlisted data.
const FORBIDDEN_IN_ALLOWED = [/\b\d{5,}\b/];

export function nameTokens(key) {
  return String(key)
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveProperty(key) {
  const tokens = nameTokens(key);
  return tokens.some((t) => SENSITIVE_TOKENS.has(t)) || SENSITIVE_TOKENS.has(tokens.join(''));
}

/**
 * Reviewed PostHog-added properties (scripts/posthog-reviewed-properties.json).
 * Each entry needs a name, a reason, who reviewed it and when. A sensitive
 * property can never be accepted by review.
 */
export function loadReviewed(entries) {
  if (!Array.isArray(entries)) throw new Error('The reviewed-properties file must be a JSON array.');
  const names = new Set();
  for (const e of entries) {
    const missing = ['name', 'reason', 'reviewedBy', 'reviewedOn'].filter((k) => typeof e?.[k] !== 'string' || !e[k].trim());
    if (missing.length) throw new Error(`Reviewed property ${JSON.stringify(e?.name ?? e)} is missing: ${missing.join(', ')}`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.reviewedOn)) throw new Error(`Reviewed property ${e.name}: reviewedOn must be YYYY-MM-DD`);
    if (isSensitiveProperty(e.name)) throw new Error(`Reviewed property ${e.name} is sensitive and cannot be accepted by review.`);
    if (ALLOWED.has(e.name)) throw new Error(`Reviewed property ${e.name} is already allowlisted.`);
    names.add(e.name);
  }
  return names;
}

export const recentEventsQuery = (hours) => ({
  kind: 'HogQLQuery',
  query: `select event, distinct_id, timestamp, properties from events
          where event in (${EVENTS.map((e) => `'${e}'`).join(', ')})
            and properties.environment = 'test'
            and timestamp > now() - interval ${Number(hours)} hour
          order by timestamp limit 1000`,
});

const stringValues = (v) => (typeof v === 'string' ? [v] : v && typeof v === 'object' ? Object.values(v).flatMap(stringValues) : []);

/**
 * rows: [event, distinct_id, timestamp, properties(object or JSON string)]
 * reviewed: Set of PostHog-added property names accepted by explicit review.
 */
export function analyse(rows, windowHours = 24, reviewed = new Set()) {
  const events = rows.map(([event, distinctId, timestamp, properties]) => ({
    event, distinctId, timestamp: new Date(timestamp).getTime(),
    properties: typeof properties === 'string' ? JSON.parse(properties) : properties ?? {},
  }));
  const counts = Object.fromEntries(EVENTS.map((e) => [e, events.filter((x) => x.event === e).length]));
  const sensitive = new Set();
  const unreviewed = new Set();
  const reviewedSeen = new Set();
  const problems = [];
  for (const e of events) {
    for (const [k, v] of Object.entries(e.properties)) {
      if (ALLOWED.has(k)) continue;
      if (isSensitiveProperty(k)) {
        sensitive.add(k);
        problems.push(`${e.event}: sensitive property "${k}"`);
      } else if (!k.startsWith('$')) {
        problems.push(`${e.event}: unexpected property "${k}"`);
      } else if (reviewed.has(k)) {
        reviewedSeen.add(k);
      } else {
        unreviewed.add(k);
      }
      for (const s of stringValues(v)) {
        for (const re of FORBIDDEN_ANYWHERE) if (re.test(s)) problems.push(`${e.event}: value matching ${re} in "${k}"`);
      }
    }
    const allowedText = JSON.stringify({ d: e.distinctId, p: Object.fromEntries(Object.entries(e.properties).filter(([k]) => ALLOWED.has(k))) });
    for (const re of [...FORBIDDEN_ANYWHERE, ...FORBIDDEN_IN_ALLOWED]) if (re.test(allowedText)) problems.push(`${e.event}: value matching ${re} in allowlisted data`);
    if (!/^an_[a-z0-9_]+$/.test(e.distinctId)) problems.push(`${e.event}: distinct_id is not an opaque analytics id`);
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
  return {
    counts,
    funnel: { started: starters.size, confirmed: converted },
    sensitiveProperties: [...sensitive].sort(),
    unreviewedProperties: [...unreviewed].sort(),
    reviewedProperties: [...reviewedSeen].sort(),
    problems: [...new Set(problems)],
  };
}

/**
 * Verdict for the analytics checks (not for milestone 2).
 *   failed       : sensitive or unexpected properties, forbidden values, or non-opaque ids
 *   needs-review : PostHog-added properties nobody has reviewed yet
 *   incomplete   : no events, a required event missing, or no completed funnel
 *   verified     : all required events, a completed funnel, nothing sensitive or unreviewed
 */
export function verdict(report, required = EVENTS) {
  const scope = 'analytics checks only; milestone 2 also needs the other external verifications';
  if (report.problems.length) return { status: 'failed', verified: false, scope, reasons: report.problems };
  if (report.unreviewedProperties.length) {
    return {
      status: 'needs-review',
      verified: false,
      scope,
      reasons: report.unreviewedProperties.map((k) => `PostHog added "${k}", which has not been reviewed. Review it and record it in scripts/posthog-reviewed-properties.json, or stop PostHog adding it.`),
    };
  }
  const reasons = [];
  const total = Object.values(report.counts).reduce((a, b) => a + b, 0);
  if (total === 0) reasons.push('No test events were received.');
  for (const e of required) if (!report.counts[e]) reasons.push(`Missing required event: ${e}`);
  if (report.funnel.confirmed < 1) reasons.push('No completed payment started -> payment confirmed funnel.');
  return reasons.length ? { status: 'incomplete', verified: false, scope, reasons } : { status: 'verified', verified: true, scope, reasons: [] };
}
