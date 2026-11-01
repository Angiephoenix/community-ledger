// Access-boundary checks against the Supabase TEST project, using genuine
// sign-in sessions (the same public API and publishable key as the app).
//
//   node scripts/check-access.mjs            members A-D, the officer, and anonymous
//   node scripts/check-access.mjs --anon     anonymous checks only (no sign-in)
//
// Reads VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY and (optionally)
// VITE_SUPABASE_FUNCTIONS_URL from the environment or from .env.local.
// Asks for each test account's email and password at the prompt; the password
// is not echoed. Passwords and session tokens stay in memory only: nothing is
// written to disk, and the output shows only PASS/FAIL, row counts and error
// codes, never row contents, emails or tokens.
//
// Data safety: the checker only reads, or calls privileged operations with
// arguments that are rejected by validation even if the access check were
// missing, so a refusal is shown by the error code (42501) and a failure
// changes nothing. The exception is the cross-member payment probe: if a member
// could start a payment for another member's charge, that probe would leave an
// unsubmitted ("started") attempt, which the final check reports. Three officer jobs that take no arguments and would change
// data if the check failed (recurring dues, reminders, message previews) are
// not called; they use the same app.require_officer() guard as the officer
// operations that are called.
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// ---------------------------------------------------------------- config
function loadEnvLocal() {
  const out = {};
  if (!existsSync('.env.local')) return out;
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}
const fileEnv = loadEnvLocal();
const env = (k) => process.env[k] || fileEnv[k] || '';
const URL_ = env('VITE_SUPABASE_URL');
const KEY = env('VITE_SUPABASE_PUBLISHABLE_KEY');
const FUNCTIONS = env('VITE_SUPABASE_FUNCTIONS_URL') || `${URL_}/functions/v1`;
if (!URL_ || !KEY) {
  console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY (environment or .env.local).');
  process.exit(2);
}
if (!KEY.startsWith('sb_publishable_')) {
  console.error('VITE_SUPABASE_PUBLISHABLE_KEY must be the publishable key. Refusing to run with any other key.');
  process.exit(2);
}

// Fixed ids of the fictional seed members (supabase/seed.sql).
const MEMBERS = {
  A: '00000000-0000-4000-8000-00000000000a',
  B: '00000000-0000-4000-8000-00000000000b',
  C: '00000000-0000-4000-8000-00000000000c',
  D: '00000000-0000-4000-8000-00000000000d',
};
const OWN_ROWS = [
  // table, column holding the member id
  ['members', 'id'], ['charges', 'member_id'], ['payment_attempts', 'member_id'], ['payments', 'member_id'],
  ['receipts', 'member_id'], ['charge_balances', 'member_id'], ['member_balances', 'member_id'], ['payment_attempt_overview', 'member_id'],
];
const OFFICER_ONLY = ['officers', 'levies', 'levy_targets', 'outbox_messages', 'tasks', 'job_runs', 'audit_events'];
const ALL_TABLES = [...OWN_ROWS.map(([t]) => t), 'adjustments', 'allocations', 'payment_attempt_charges', 'organisations', 'dues_rules', ...OFFICER_ONLY];

// ---------------------------------------------------------------- output
const results = [];
function record(who, ok, name, detail = '') {
  results.push({ who, ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${who.padEnd(9)} ${name}${detail ? ` (${detail})` : ''}`);
}
const refused = (error) => Boolean(error) && (error.code === '42501' || /permission denied|Only officers|Sign in/i.test(error.message ?? ''));
const codeOf = (error) => (error ? error.code || 'error' : 'no error');

// ---------------------------------------------------------------- prompts
const muted = new Writable({ write: (_c, _e, cb) => cb() });
async function ask(question, hidden = false) {
  process.stdout.write(question);
  const rl = createInterface({ input: process.stdin, output: hidden ? muted : process.stdout, terminal: true });
  const answer = await new Promise((resolve) => rl.question('', resolve));
  rl.close();
  if (hidden) process.stdout.write('\n');
  return answer.trim();
}

const client = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });

async function signIn(label) {
  const email = await ask(`${label} email: `);
  const password = await ask(`${label} password (hidden): `, true);
  const sb = client();
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    record(label, false, 'sign in', `failed: ${error.status ?? ''} ${error.code ?? ''}`.trim());
    return null;
  }
  record(label, true, 'sign in');
  return sb;
}

async function callFunction(sb, name, body) {
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: KEY, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ---------------------------------------------------------------- privileged operations
// Each is called with arguments that validation rejects anyway, so a missing
// access check would show up as a non-42501 error and still change nothing.
const nobody = randomUUID();
const PRIVILEGED = [
  ['collection_report', {}],
  ['review_task', { p_task_id: nobody, p_note: 'access check' }],
  ['publish_levy', { p_name: '', p_amount_kobo: 0, p_issue_date: '2026-11-24', p_due_date: '2026-11-23', p_member_ids: [] }],
  ['add_adjustment', { p_charge_id: nobody, p_amount_kobo: 0, p_reason: '' }],
  ['record_opening_payment', { p_member_id: nobody, p_charge_id: nobody, p_amount_kobo: 0, p_note: '' }],
  // Server-only (not granted to signed-in users at all). Only calls that read,
  // claim nothing (limit 0) or fail a foreign key (unknown user) are made; the
  // full server-function grant list is checked by tests/db/access.test.ts.
  ['server_grant_officer', { p_user_id: nobody, p_granted_by: 'access check' }],
  ['server_attempts_to_reconcile', { p_older_than_seconds: 0, p_limit: 1 }],
  ['server_claim_provider_events', { p_limit: 0, p_lease_seconds: 1 }],
  ['server_claim_analytics_events', { p_limit: 0, p_lease_seconds: 1 }],
];
// Direct writes. Values break table constraints, so a missing privilege check
// shows up as a constraint error (FAIL) rather than a stored row.
const WRITES = [
  ['insert payments', (sb) => sb.from('payments').insert({ amount_kobo: -1 })],
  ['insert charges', (sb) => sb.from('charges').insert({ amount_kobo: -1 })],
  ['insert receipts', (sb) => sb.from('receipts').insert({ amount_kobo: -1 })],
  ['update members', (sb) => sb.from('members').update({ display_name: null }).eq('id', nobody)],
  ['delete allocations', (sb) => sb.from('allocations').delete().eq('id', nobody)],
];

async function privilegedRefused(who, sb) {
  for (const [fn, args] of PRIVILEGED) {
    const { error } = await sb.rpc(fn, args);
    record(who, refused(error), `${fn} refused`, codeOf(error));
  }
  for (const [name, run] of WRITES) {
    const { error, count } = await run(sb);
    // PostgREST answers 42501 when there is no privilege. An update/delete
    // with no matching rows and no error would mean the privilege exists.
    record(who, refused(error), `${name} refused`, error ? codeOf(error) : `no error, ${count ?? 0} rows`);
  }
}

// ---------------------------------------------------------------- checks
async function checkAnonymous() {
  const sb = client();
  for (const t of ALL_TABLES) {
    const { data, error } = await sb.from(t).select('*').limit(50);
    record('anonymous', Boolean(error) || (data ?? []).length === 0, `read ${t}`, error ? codeOf(error) : `${data.length} rows`);
  }
  for (const fn of ['whoami', 'ledger_clock']) {
    const { error } = await sb.rpc(fn);
    record('anonymous', refused(error), `${fn} refused`, codeOf(error));
  }
  {
    const { error } = await sb.rpc('start_payment_attempt', { p_charge_ids: [nobody] });
    record('anonymous', refused(error), 'start_payment_attempt refused', codeOf(error));
  }
  await privilegedRefused('anonymous', sb);
  const fn = await callFunction(sb, 'create-checkout', { chargeIds: [nobody] });
  record('anonymous', fn.status === 401, 'create-checkout without a session refused', `HTTP ${fn.status}`);
}

async function checkMember(k, sb, known) {
  const who = `Member ${k}`;
  const own = MEMBERS[k];
  const { data: me, error: meErr } = await sb.rpc('whoami');
  record(who, !meErr && me?.member_id === own && me?.is_officer === false, 'whoami is this member, not an officer', meErr ? codeOf(meErr) : '');

  for (const [t, col] of OWN_ROWS) {
    const { data, error } = await sb.from(t).select(col);
    const rows = data ?? [];
    const foreign = rows.filter((r) => r[col] !== own).length;
    record(who, !error && foreign === 0, `read ${t}: only own rows`, error ? codeOf(error) : `${rows.length} rows, ${foreign} not own`);
  }
  const ownCharges = new Set(((await sb.from('charges').select('id')).data ?? []).map((r) => r.id));
  const ownAttempts = new Set(((await sb.from('payment_attempts').select('id')).data ?? []).map((r) => r.id));
  for (const [t, col, set] of [['adjustments', 'charge_id', ownCharges], ['allocations', 'charge_id', ownCharges], ['payment_attempt_charges', 'attempt_id', ownAttempts]]) {
    const { data, error } = await sb.from(t).select(col);
    const rows = data ?? [];
    const foreign = rows.filter((r) => !set.has(r[col])).length;
    record(who, !error && foreign === 0, `read ${t}: only own rows`, error ? codeOf(error) : `${rows.length} rows, ${foreign} not own`);
  }
  for (const [other, id] of Object.entries(MEMBERS)) {
    if (other === k) continue;
    const { data: m } = await sb.from('members').select('id').eq('id', id);
    const { data: c } = await sb.from('charges').select('id').eq('member_id', id);
    const { data: b } = await sb.from('member_balances').select('member_id').eq('member_id', id);
    const n = (m?.length ?? 0) + (c?.length ?? 0) + (b?.length ?? 0);
    record(who, n === 0, `cannot read Member ${other}'s profile, charges or balance`, `${n} rows`);
  }
  for (const t of OFFICER_ONLY) {
    const { data, error } = await sb.from(t).select('*').limit(50);
    record(who, Boolean(error) || (data ?? []).length === 0, `read officer-only ${t}`, error ? codeOf(error) : `${data.length} rows`);
  }

  // Someone else's payment and charges, as found through the officer session.
  for (const ref of known.references.filter((r) => r.member !== own)) {
    const { data, error } = await sb.rpc('my_payment_attempt', { p_reference: ref.reference });
    record(who, !error && data == null, "my_payment_attempt hides another member's payment", error ? codeOf(error) : data == null ? 'null' : 'returned data');
    const ret = await callFunction(sb, 'payment-return', { reference: ref.reference });
    record(who, ret.json?.status === 'not-found', "payment-return hides another member's payment", `HTTP ${ret.status}, ${ret.json?.status ?? 'no status'}`);
    break; // one is enough per member
  }
  const otherCharge = known.charges.find((c) => c.member !== own);
  if (otherCharge) {
    const { error } = await sb.rpc('start_payment_attempt', { p_charge_ids: [otherCharge.id] });
    record(who, refused(error) || /own charges/.test(error?.message ?? ''), "cannot start a payment for another member's charge", codeOf(error));
    const fn = await callFunction(sb, 'create-checkout', { chargeIds: [otherCharge.id] });
    record(who, fn.json?.ok === false && /own charges/.test(fn.json?.message ?? ''), "create-checkout refuses another member's charge", `HTTP ${fn.status}`);
  }
  const pend = known.references.find((r) => r.member !== own && r.status === 'pending');
  if (pend) {
    await sb.rpc('abandon_payment_attempt', { p_attempt_id: pend.id });
  }
  const worker = await callFunction(sb, 'process-payments', {});
  record(who, worker.status === 401, 'process-payments refuses a member session', `HTTP ${worker.status}`);
  await privilegedRefused(who, sb);
}

async function checkOfficer(sb) {
  const who = 'Officer';
  const { data: me, error } = await sb.rpc('whoami');
  record(who, !error && me?.is_officer === true && me?.member_id == null, 'whoami is an officer, not a member', error ? codeOf(error) : '');
  const { data: members } = await sb.from('members').select('id');
  const ids = new Set((members ?? []).map((m) => m.id));
  record(who, Object.values(MEMBERS).every((id) => ids.has(id)), 'reads all four members', `${ids.size} rows`);
  const { data: tasks } = await sb.from('tasks').select('id').eq('status', 'open');
  record(who, (tasks ?? []).length >= 1, 'reads Needs attention items', `${(tasks ?? []).length} open`);
  const { error: repErr } = await sb.rpc('collection_report');
  record(who, !repErr, 'collection_report allowed', codeOf(repErr));
  // Server-only operations stay refused for officers too.
  for (const fn of ['server_grant_officer', 'server_attempts_to_reconcile', 'server_claim_provider_events']) {
    const args = PRIVILEGED.find(([n]) => n === fn)[1];
    const { error: e } = await sb.rpc(fn, args);
    record(who, refused(e), `${fn} refused`, codeOf(e));
  }
  for (const [name, run] of WRITES) {
    const { error: e, count } = await run(sb);
    record(who, refused(e), `${name} refused`, e ? codeOf(e) : `no error, ${count ?? 0} rows`);
  }
  const { error: payErr } = await sb.rpc('start_payment_attempt', { p_charge_ids: [nobody] });
  record(who, refused(payErr), 'officer (not a member) cannot start a payment', codeOf(payErr));

  const { data: atts } = await sb.from('payment_attempts').select('id, reference, member_id, status');
  const { data: charges } = await sb.from('charges').select('id, member_id');
  return {
    references: (atts ?? []).map((a) => ({ id: a.id, reference: a.reference, member: a.member_id, status: a.status })),
    charges: (charges ?? []).map((c) => ({ id: c.id, member: c.member_id })),
    attemptStatuses: Object.fromEntries((atts ?? []).map((a) => [a.id, a.status])),
  };
}

// ---------------------------------------------------------------- run
console.log(`Access checks against ${new URL(URL_).host} (test project). Output shows results only.\n`);
await checkAnonymous();

if (!process.argv.includes('--anon')) {
  console.log('\nSign in as the officer first (used to find other members\' records to probe).');
  const off = await signIn('Officer');
  let known = { references: [], charges: [], attemptStatuses: {} };
  if (off) known = await checkOfficer(off);
  for (const k of ['A', 'B', 'C', 'D']) {
    console.log('');
    const sb = await signIn(`Member ${k}`);
    if (sb) {
      await checkMember(k, sb, known);
      await sb.auth.signOut();
    }
  }
  if (off) {
    // Nothing a member did may have changed another member's payment attempts.
    const { data: after } = await off.from('payment_attempts').select('id, status');
    const changed = (after ?? []).filter((a) => known.attemptStatuses[a.id] !== undefined && known.attemptStatuses[a.id] !== a.status).length;
    const added = (after ?? []).filter((a) => known.attemptStatuses[a.id] === undefined).length;
    record('Officer', changed === 0 && added === 0, 'payment attempts unchanged by the member checks', `${changed} changed, ${added} added`);
    await off.auth.signOut();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed.`);
if (failed.length) for (const f of failed) console.log(`  FAILED: ${f.who}: ${f.name} (${f.detail})`);
process.exit(failed.length ? 1 : 0);
