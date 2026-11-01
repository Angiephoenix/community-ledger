// Reads back the events a PostHog TEST project actually received and checks
// them: counts, the payment-started -> payment-confirmed funnel, properties
// PostHog added itself, and anything outside the allowlist.
//
// Needs POSTHOG_APP_HOST (e.g. https://eu.posthog.com), POSTHOG_PROJECT_ID and
// POSTHOG_PERSONAL_API_KEY (with Query Read) in the environment. Never prints
// the key.   node scripts/verify-posthog.mjs [hours]
//
// Not yet run: no PostHog test project was available.
import { analyse, recentEventsQuery } from './posthog-check.mjs';

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
const report = analyse(body.results ?? [], 24);
console.log(JSON.stringify(report, null, 2));
process.exit(report.problems.length ? 2 : 0);
