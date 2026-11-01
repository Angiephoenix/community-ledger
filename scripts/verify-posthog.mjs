// Reads back the events a PostHog TEST project actually received and checks
// them: counts, the payment-started -> payment-confirmed funnel, properties
// PostHog added itself, and anything outside the allowlist.
//
// Analytics counts as verified only if every expected event arrived, a funnel
// completed and nothing leaked. Exit codes: 0 verified, 2 failed, 3 incomplete
// (including zero events), 1 the query itself failed.
//
// Needs POSTHOG_APP_HOST (e.g. https://eu.posthog.com), POSTHOG_PROJECT_ID and
// POSTHOG_PERSONAL_API_KEY (with Query Read) in the environment. Never prints
// the key.   node scripts/verify-posthog.mjs [hours]
//
// Not yet run: no PostHog test project was available.
import { analyse, recentEventsQuery, verdict } from './posthog-check.mjs';

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing ${k}. Set it in your environment (its value is never printed).`);
    process.exit(1);
  }
  return v;
};
const host = need('POSTHOG_APP_HOST').replace(/\/$/, '');
const projectId = need('POSTHOG_PROJECT_ID');
const key = need('POSTHOG_PERSONAL_API_KEY');
const hours = Number(process.argv[2] ?? 24);

const res = await fetch(`${host}/api/projects/${encodeURIComponent(projectId)}/query/`, {
  method: 'POST',
  headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  body: JSON.stringify({ query: recentEventsQuery(hours), name: 'community-ledger verify-posthog' }),
});
if (!res.ok) {
  console.error(`PostHog query failed: HTTP ${res.status}`);
  process.exit(1);
}
const body = await res.json();
if (!Array.isArray(body.results)) {
  console.error('PostHog query returned no result rows (the query may still be running). Analytics NOT verified.');
  process.exit(1);
}
const report = analyse(body.results, 24);
const result = verdict(report);
console.log(JSON.stringify({ ...report, verdict: result }, null, 2));
console.log(result.verified ? 'Analytics VERIFIED.' : `Analytics NOT verified (${result.status}): ${result.reasons.join(' ')}`);
process.exit(result.verified ? 0 : result.status === 'failed' ? 2 : 3);
