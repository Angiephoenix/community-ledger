// Decision logic for scripts/check-access.mjs, kept free of network and prompt
// code so every outcome can be tested (tests/check-access.test.ts).
//
// Every response is classified before it is judged:
//   ok          the request succeeded (2xx, no error)
//   denied      PostgreSQL refused it for lack of privilege (SQLSTATE 42501)
//   validation  the request got past authorization and was rejected by a
//               validation or constraint error (it should have been refused
//               earlier, so this is a FAIL when a refusal was expected)
//   unexpected  anything else: network failure, HTTP 5xx, expired session,
//               unknown function or column, misconfiguration. Never a PASS.
//
// Results are PASS, FAIL, INCONCLUSIVE (the answer does not prove either way)
// or SKIPPED (a prerequisite such as the officer baseline is missing). The run
// succeeds only when every check passed.

export const MEMBERS = {
  A: '00000000-0000-4000-8000-00000000000a',
  B: '00000000-0000-4000-8000-00000000000b',
  C: '00000000-0000-4000-8000-00000000000c',
  D: '00000000-0000-4000-8000-00000000000d',
};

// Tables and views a member may read, and how a row is tied to a member.
// `via` rows are tied through a charge or an attempt.
export const MEMBER_TABLES = [
  { table: 'members', columns: 'id', owner: (r) => r.id },
  { table: 'charges', columns: 'id, member_id', owner: (r) => r.member_id },
  { table: 'payment_attempts', columns: 'id, member_id', owner: (r) => r.member_id },
  { table: 'payments', columns: 'id, member_id', owner: (r) => r.member_id },
  { table: 'receipts', columns: 'id, member_id', owner: (r) => r.member_id },
  { table: 'charge_balances', columns: 'id, member_id', owner: (r) => r.member_id },
  { table: 'member_balances', columns: 'member_id', owner: (r) => r.member_id },
  { table: 'payment_attempt_overview', columns: 'id, member_id', owner: (r) => r.member_id },
  { table: 'adjustments', columns: 'id, charge_id', via: 'charge', key: (r) => r.charge_id },
  { table: 'allocations', columns: 'id, charge_id', via: 'charge', key: (r) => r.charge_id },
  { table: 'payment_attempt_charges', columns: 'attempt_id, charge_id', via: 'attempt', key: (r) => r.attempt_id },
];
// Readable by any signed-in member (not member-specific).
export const SHARED_TABLES = ['organisations', 'dues_rules'];
export const OFFICER_ONLY = ['officers', 'levies', 'levy_targets', 'outbox_messages', 'tasks', 'job_runs', 'audit_events'];
export const ALL_TABLES = [...MEMBER_TABLES.map((t) => t.table), ...SHARED_TABLES, ...OFFICER_ONLY];

// Probed by member id with a filter, as well as by reading everything.
export const TARGETED = [
  { table: 'members', column: 'id' },
  { table: 'charges', column: 'member_id' },
  { table: 'payments', column: 'member_id' },
  { table: 'member_balances', column: 'member_id' },
];

const NOBODY = '00000000-0000-4000-8000-0000000000ff';

/**
 * Privileged operations called in the default run. For each, the code path
 * was checked so that a call rejected by validation (or affecting no row)
 * changes nothing even if the authorization check were missing:
 *   collection_report             read-only (STABLE)
 *   review_task                   updates `where id = <unknown>`: no row, no audit line
 *   publish_levy                  empty name is rejected before any insert
 *   add_adjustment                unknown charge is rejected before any insert
 *   record_opening_payment        charge/member mismatch is rejected before any insert
 *   server_grant_officer          unknown user fails the foreign key; the statement rolls back
 *   server_attempts_to_reconcile  read-only SELECT
 */
export const PRIVILEGED_SAFE = [
  ['collection_report', {}],
  ['review_task', { p_task_id: NOBODY, p_note: 'access check' }],
  ['publish_levy', { p_name: '', p_amount_kobo: 0, p_issue_date: '2026-11-24', p_due_date: '2026-11-23', p_member_ids: [] }],
  ['add_adjustment', { p_charge_id: NOBODY, p_amount_kobo: 0, p_reason: '' }],
  ['record_opening_payment', { p_member_id: NOBODY, p_charge_id: NOBODY, p_amount_kobo: 0, p_note: '' }],
  ['server_grant_officer', { p_user_id: NOBODY, p_granted_by: 'access check' }],
  ['server_attempts_to_reconcile', { p_older_than_seconds: 0, p_limit: 1 }],
];

/**
 * Not called by the live checker at all. server_claim_provider_events and
 * server_claim_analytics_events use greatest(p_limit, 1), so even p_limit = 0
 * would claim a row if authorization were missing. Their refusal is covered by
 * the database tests (tests/db/access.test.ts) and the grant inventory, not by
 * the live run.
 */
export const NOT_PROBED_LIVE = ['server_claim_provider_events', 'server_claim_analytics_events', 'server_set_test_clock',
  'server_link_member_user', 'server_post_verified_payment', 'run_recurring_assessment', 'run_reminder_job', 'deliver_reminder_previews'];

// Direct writes. Values violate NOT NULL / CHECK constraints and updates or
// deletes match no row, so nothing is stored even if a privilege existed;
// the error code shows which layer answered.
export const WRITES = [
  ['insert payments', { op: 'insert', table: 'payments', values: { amount_kobo: -1 } }],
  ['insert charges', { op: 'insert', table: 'charges', values: { amount_kobo: -1 } }],
  ['insert receipts', { op: 'insert', table: 'receipts', values: { amount_kobo: -1 } }],
  ['update members', { op: 'update', table: 'members', values: { display_name: null }, eq: ['id', NOBODY] }],
  ['delete allocations', { op: 'delete', table: 'allocations', eq: ['id', NOBODY] }],
];

/** Opt-in probes (--include-mutating-probes). Each could change live data if the authorization it tests were broken. */
export const MUTATING_PROBES = [
  "start_payment_attempt for another member's charge (would create a payment attempt)",
  "create-checkout for another member's charge (would create a payment attempt and contact the provider)",
  "payment-return for another member's reference (would ask the provider and could record a payment)",
  'process-payments with a member session (would run the payment worker)',
];

const VALIDATION_CODES = new Set(['22023', '22004', '23502', '23503', '23505', '23514', 'P0001']);

export function classify(res) {
  if (!res || typeof res !== 'object') return { kind: 'unexpected', detail: 'no response' };
  const { error, status } = res;
  if (!error) {
    if (typeof status === 'number' && (status < 200 || status >= 300)) return { kind: 'unexpected', detail: `HTTP ${status}` };
    return { kind: 'ok', detail: `HTTP ${status ?? '?'}` };
  }
  const code = typeof error.code === 'string' ? error.code : '';
  if (code === '42501') return { kind: 'denied', detail: '42501' };
  if (VALIDATION_CODES.has(code)) return { kind: 'validation', detail: code };
  if (code) return { kind: 'unexpected', detail: code };
  if (typeof status === 'number' && status > 0) return { kind: 'unexpected', detail: `HTTP ${status}` };
  return { kind: 'unexpected', detail: 'network or client error' };
}

// ---------------------------------------------------------------- results
export class Results {
  constructor(log = () => {}) {
    this.items = [];
    this.notRun = [];
    this.log = log;
  }
  add(who, status, name, detail = '') {
    this.items.push({ who, status, name, detail });
    this.log(`${status.padEnd(12)} ${who.padEnd(9)} ${name}${detail ? ` (${detail})` : ''}`);
  }
  pass(who, name, detail) { this.add(who, 'PASS', name, detail); }
  fail(who, name, detail) { this.add(who, 'FAIL', name, detail); }
  inconclusive(who, name, detail) { this.add(who, 'INCONCLUSIVE', name, detail); }
  skip(who, name, detail) { this.add(who, 'SKIPPED', name, detail); }
  counts() {
    const c = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0, SKIPPED: 0 };
    for (const i of this.items) c[i.status] += 1;
    return c;
  }
  /** Exit code: 0 only when every check that should have run passed. */
  exitCode() {
    const c = this.counts();
    if (c.FAIL) return 1;
    if (c.INCONCLUSIVE || c.SKIPPED || c.PASS === 0) return 3;
    return 0;
  }
  summary() {
    const c = this.counts();
    const lines = [`${c.PASS} passed, ${c.FAIL} failed, ${c.INCONCLUSIVE} inconclusive, ${c.SKIPPED} skipped.`];
    for (const status of ['FAIL', 'INCONCLUSIVE', 'SKIPPED']) {
      for (const i of this.items.filter((x) => x.status === status)) lines.push(`  ${status}: ${i.who}: ${i.name}${i.detail ? ` (${i.detail})` : ''}`);
    }
    if (this.notRun.length) {
      lines.push('Not run (could change data if the authorization being tested were broken):');
      for (const n of this.notRun) lines.push(`  - ${n}`);
    }
    const code = this.exitCode();
    lines.push(code === 0 ? 'Result: all checks passed.' : code === 1 ? 'Result: FAILED.' : 'Result: INCOMPLETE (some checks were inconclusive or skipped).');
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------- judgements
/** A refusal is expected: only 42501 passes. */
export function judgeRefused(R, who, name, res) {
  const c = classify(res);
  if (c.kind === 'denied') return R.pass(who, name, c.detail);
  if (c.kind === 'ok') return R.fail(who, name, 'allowed');
  if (c.kind === 'validation') return R.fail(who, name, `not refused by authorization; rejected later with ${c.detail}`);
  return R.inconclusive(who, name, c.detail);
}

/** A read must be refused or return nothing. An empty result only counts if rows exist to be hidden. */
export function judgeHidden(R, who, name, res, rowsThatExist) {
  const c = classify(res);
  if (c.kind === 'denied') return R.pass(who, name, c.detail);
  if (c.kind !== 'ok') return R.inconclusive(who, name, c.detail);
  const n = Array.isArray(res.data) ? res.data.length : res.data == null ? 0 : 1;
  if (n > 0) return R.fail(who, name, `${n} rows visible`);
  if (rowsThatExist == null) return R.inconclusive(who, name, 'empty, but no officer baseline to show rows exist');
  if (rowsThatExist === 0) return R.inconclusive(who, name, 'empty, but there are no rows to hide');
  return R.pass(who, name, `0 of ${rowsThatExist} rows`);
}

/** A read must succeed (the officer, or a member reading their own records). */
export function judgeAllowed(R, who, name, res) {
  const c = classify(res);
  if (c.kind === 'ok') { R.pass(who, name); return true; }
  if (c.kind === 'denied') { R.fail(who, name, 'refused'); return false; }
  R.inconclusive(who, name, c.detail);
  return false;
}

export function judgeHttp(R, who, name, res, expected) {
  if (!res || res.error) return R.inconclusive(who, name, 'network error');
  if (res.status === expected) return R.pass(who, name, `HTTP ${res.status}`);
  if (res.status >= 500) return R.inconclusive(who, name, `HTTP ${res.status}`);
  return R.fail(who, name, `HTTP ${res.status}`);
}

// ---------------------------------------------------------------- baseline
/**
 * Reads, as the officer, what exists. Returns null if any read was not
 * successful (the dependent checks are then skipped).
 */
export async function readBaseline(R, officer) {
  const out = { rows: {}, chargeOwner: new Map(), attemptOwner: new Map() };
  let complete = true;
  const reads = [
    ...MEMBER_TABLES.map((t) => [t.table, t.columns]),
    ['payment_attempts', 'id, member_id, status, amount_kobo, reference'],
    ...SHARED_TABLES.map((t) => [t, '*']),
    ...OFFICER_ONLY.map((t) => [t, '*']),
  ];
  for (const [table, columns] of reads) {
    const key = columns === 'id, member_id, status, amount_kobo, reference' ? 'payment_attempts_full' : table;
    const res = await officer.select(table, { columns });
    if (!judgeAllowed(R, 'Officer', `baseline read ${key}`, res)) { complete = false; continue; }
    out.rows[key] = Array.isArray(res.data) ? res.data : [];
  }
  if (!complete) return null;
  for (const r of out.rows.charges) out.chargeOwner.set(r.id, r.member_id);
  for (const r of out.rows.payment_attempts) out.attemptOwner.set(r.id, r.member_id);
  const ids = new Set(out.rows.members.map((m) => m.id));
  const missing = Object.entries(MEMBERS).filter(([, id]) => !ids.has(id)).map(([k]) => k);
  if (missing.length) { R.fail('Officer', 'baseline has members A–D', `missing ${missing.join(', ')}`); return null; }
  R.pass('Officer', 'baseline has members A–D');
  return out;
}

export function ownerOf(baseline, spec, row) {
  if (!spec.via) return spec.owner(row);
  const map = spec.via === 'charge' ? baseline.chargeOwner : baseline.attemptOwner;
  return map.get(spec.key(row));
}

/** Stable fingerprint of records a member action could change. Background jobs may add audit, job and outbox rows, so those are left out. */
export function fingerprint(baseline) {
  const pick = (rows, f) => (rows ?? []).map(f).sort();
  return JSON.stringify({
    attempts: pick(baseline.rows.payment_attempts_full, (r) => `${r.id}:${r.status}:${r.amount_kobo}:${r.member_id}`),
    payments: pick(baseline.rows.payments, (r) => r.id),
    receipts: pick(baseline.rows.receipts, (r) => r.id),
    allocations: pick(baseline.rows.allocations, (r) => r.id),
    adjustments: pick(baseline.rows.adjustments, (r) => r.id),
    charges: pick(baseline.rows.charges, (r) => r.id),
    attemptCharges: pick(baseline.rows.payment_attempt_charges, (r) => `${r.attempt_id}:${r.charge_id}`),
    officers: pick(baseline.rows.officers, (r) => r.user_id),
    levies: pick(baseline.rows.levies, (r) => r.id),
    levyTargets: (baseline.rows.levy_targets ?? []).length,
    tasks: pick(baseline.rows.tasks, (r) => `${r.id}:${r.status}`),
  });
}

// ---------------------------------------------------------------- check groups
async function privilegedAndWrites(R, who, client) {
  for (const [fn, args] of PRIVILEGED_SAFE) judgeRefused(R, who, `${fn} refused`, await client.rpc(fn, args));
  for (const [name, w] of WRITES) judgeRefused(R, who, `${name} refused`, await client.write(w));
}

export async function checkAnonymous(R, anon, baseline) {
  const who = 'anonymous';
  for (const t of ALL_TABLES) {
    const exist = baseline ? (baseline.rows[t] ?? []).length : null;
    judgeHidden(R, who, `read ${t}`, await anon.select(t, { columns: '*', limit: 50 }), exist);
  }
  for (const fn of ['whoami', 'ledger_clock']) judgeRefused(R, who, `${fn} refused`, await anon.rpc(fn, {}));
  // Without a session there is no member, so this is rejected before any insert.
  judgeRefused(R, who, 'start_payment_attempt refused', await anon.rpc('start_payment_attempt', { p_charge_ids: [NOBODY] }));
  await privilegedAndWrites(R, who, anon);
  // Without a user the handler answers before any database call, even if the gateway let it through.
  judgeHttp(R, who, 'create-checkout without a session refused', await anon.fn('create-checkout', { chargeIds: [NOBODY] }), 401);
}

export async function checkOfficer(R, officer) {
  const who = 'Officer';
  const me = await officer.rpc('whoami', {});
  const c = classify(me);
  if (c.kind !== 'ok') R.inconclusive(who, 'whoami is an officer, not a member', c.detail);
  else if (me.data?.is_officer === true && me.data?.member_id == null) R.pass(who, 'whoami is an officer, not a member');
  else R.fail(who, 'whoami is an officer, not a member', `is_officer=${me.data?.is_officer}`);
  judgeAllowed(R, who, 'collection_report allowed', await officer.rpc('collection_report', {}));
  for (const fn of ['server_grant_officer', 'server_attempts_to_reconcile']) {
    judgeRefused(R, who, `${fn} refused`, await officer.rpc(fn, PRIVILEGED_SAFE.find(([n]) => n === fn)[1]));
  }
  for (const [name, w] of WRITES) judgeRefused(R, who, `${name} refused`, await officer.write(w));
  // The officer account is not a member, so this is rejected before any insert.
  judgeRefused(R, who, 'officer (not a member) cannot start a payment', await officer.rpc('start_payment_attempt', { p_charge_ids: [NOBODY] }));
}

export async function checkMember(R, k, client, baseline) {
  const who = `Member ${k}`;
  const own = MEMBERS[k];
  const me = await client.rpc('whoami', {});
  const c = classify(me);
  if (c.kind !== 'ok') R.inconclusive(who, 'whoami is this member, not an officer', c.detail);
  else if (me.data?.member_id === own && me.data?.is_officer === false) R.pass(who, 'whoami is this member, not an officer');
  else R.fail(who, 'whoami is this member, not an officer', 'signed in as a different member or as an officer');

  for (const spec of MEMBER_TABLES) {
    const name = `read ${spec.table}: only own rows`;
    const res = await client.select(spec.table, { columns: spec.columns });
    const rc = classify(res);
    if (rc.kind === 'denied') { R.fail(who, name, 'refused (a member must be able to read their own records)'); continue; }
    if (rc.kind !== 'ok') { R.inconclusive(who, name, rc.detail); continue; }
    if (!baseline) { R.skip(who, name, 'no officer baseline'); continue; }
    const rows = Array.isArray(res.data) ? res.data : [];
    const foreign = rows.filter((r) => ownerOf(baseline, spec, r) !== own).length;
    const all = baseline.rows[spec.table] ?? [];
    const ownInBaseline = all.filter((r) => ownerOf(baseline, spec, r) === own).length;
    const othersExist = all.length - ownInBaseline;
    if (foreign > 0) R.fail(who, name, `${foreign} of ${rows.length} rows belong to someone else`);
    else if (rows.length !== ownInBaseline) R.fail(who, name, `sees ${rows.length} own rows, officer sees ${ownInBaseline}`);
    else if (othersExist === 0) R.inconclusive(who, name, `${rows.length} own rows; no other members' rows exist to hide`);
    else R.pass(who, name, `${rows.length} own rows, ${othersExist} others hidden`);
  }

  for (const { table, column } of TARGETED) {
    const name = `cannot read other members' ${table} by id`;
    if (!baseline) { R.skip(who, name, 'no officer baseline'); continue; }
    let visible = 0; let existing = 0; let problem = null;
    for (const [other, id] of Object.entries(MEMBERS)) {
      if (other === k) continue;
      existing += (baseline.rows[table] ?? []).filter((r) => r[column] === id).length;
      const res = await client.select(table, { columns: column, eq: [column, id] });
      const rc = classify(res);
      if (rc.kind === 'denied') continue;
      if (rc.kind !== 'ok') { problem = rc.detail; continue; }
      visible += Array.isArray(res.data) ? res.data.length : 0;
    }
    if (visible > 0) R.fail(who, name, `${visible} rows visible`);
    else if (problem) R.inconclusive(who, name, problem);
    else if (existing === 0) R.inconclusive(who, name, 'no rows exist to hide');
    else R.pass(who, name, `0 of ${existing} rows`);
  }

  for (const t of SHARED_TABLES) judgeAllowed(R, who, `read ${t}`, await client.select(t, { columns: '*' }));
  for (const t of OFFICER_ONLY) {
    judgeHidden(R, who, `read officer-only ${t}`, await client.select(t, { columns: '*', limit: 50 }), baseline ? (baseline.rows[t] ?? []).length : null);
  }

  // my_payment_attempt is a read-only SQL function.
  const other = baseline?.rows.payment_attempts_full.find((a) => a.member_id !== own);
  if (!baseline) R.skip(who, "my_payment_attempt hides another member's payment", 'no officer baseline');
  else if (!other) R.inconclusive(who, "my_payment_attempt hides another member's payment", "no other member's payment exists");
  else {
    const res = await client.rpc('my_payment_attempt', { p_reference: other.reference });
    const rc = classify(res);
    if (rc.kind === 'denied' || (rc.kind === 'ok' && res.data == null)) R.pass(who, "my_payment_attempt hides another member's payment");
    else if (rc.kind === 'ok') R.fail(who, "my_payment_attempt hides another member's payment", 'returned data');
    else R.inconclusive(who, "my_payment_attempt hides another member's payment", rc.detail);
  }

  await privilegedAndWrites(R, who, client);
}

/**
 * A signed-in account with no member link and no officer role. Every table and
 * view must be refused or empty (with rows existing to hide), and privileged
 * operations refused. Only calls already used for members (non-mutating even
 * if authorization were broken) are made; report_discrepancy and the checkout
 * probes are not called.
 */
export async function checkUnlinked(R, client, baseline) {
  const who = 'Unlinked';
  const me = await client.rpc('whoami', {});
  const c = classify(me);
  if (c.kind !== 'ok') R.inconclusive(who, 'whoami: no member link, not an officer', c.detail);
  else if (me.data?.member_id == null && me.data?.is_officer === false) R.pass(who, 'whoami: no member link, not an officer');
  else R.fail(who, 'whoami: no member link, not an officer', me.data?.is_officer ? 'is an officer' : 'linked to a member');
  for (const t of ALL_TABLES) {
    judgeHidden(R, who, `read ${t}`, await client.select(t, { columns: '*', limit: 50 }), baseline ? (baseline.rows[t] ?? []).length : null);
  }
  for (const { table, column } of TARGETED) {
    const name = `cannot read members' ${table} by id`;
    let visible = 0; let problem = null; let existing = 0;
    for (const id of Object.values(MEMBERS)) {
      existing += (baseline?.rows[table] ?? []).filter((r) => r[column] === id).length;
      const res = await client.select(table, { columns: column, eq: [column, id] });
      const rc = classify(res);
      if (rc.kind === 'denied') continue;
      if (rc.kind !== 'ok') { problem = rc.detail; continue; }
      visible += Array.isArray(res.data) ? res.data.length : 0;
    }
    if (visible > 0) R.fail(who, name, `${visible} rows visible`);
    else if (problem) R.inconclusive(who, name, problem);
    else if (existing === 0) R.inconclusive(who, name, 'no rows exist to hide');
    else R.pass(who, name, `0 of ${existing} rows`);
  }
  const someone = baseline?.rows.payment_attempts_full?.[0];
  if (!someone) R.inconclusive(who, "my_payment_attempt hides members' payments", 'no payment exists');
  else {
    const res = await client.rpc('my_payment_attempt', { p_reference: someone.reference });
    const rc = classify(res);
    if (rc.kind === 'denied' || (rc.kind === 'ok' && res.data == null)) R.pass(who, "my_payment_attempt hides members' payments");
    else if (rc.kind === 'ok') R.fail(who, "my_payment_attempt hides members' payments", 'returned data');
    else R.inconclusive(who, "my_payment_attempt hides members' payments", rc.detail);
  }
  // Not a member, so this is rejected before any insert.
  judgeRefused(R, who, 'start_payment_attempt refused', await client.rpc('start_payment_attempt', { p_charge_ids: [NOBODY] }));
  await privilegedAndWrites(R, who, client);
}

/** Opt-in only. See MUTATING_PROBES. */
export async function mutatingProbes(R, k, client, baseline) {
  const who = `Member ${k}`;
  const own = MEMBERS[k];
  const otherCharge = baseline.rows.charges.find((c) => c.member_id !== own);
  const otherAttempt = baseline.rows.payment_attempts_full.find((a) => a.member_id !== own);
  if (otherCharge) {
    judgeRefused(R, who, "[mutating] start_payment_attempt for another member's charge refused", await client.rpc('start_payment_attempt', { p_charge_ids: [otherCharge.id] }));
    const fn = await client.fn('create-checkout', { chargeIds: [otherCharge.id] });
    if (!fn || fn.error) R.inconclusive(who, "[mutating] create-checkout refuses another member's charge", 'network error');
    else if (fn.json?.ok === false && /own charges/.test(fn.json?.message ?? '')) R.pass(who, "[mutating] create-checkout refuses another member's charge", `HTTP ${fn.status}`);
    else if (fn.status >= 500) R.inconclusive(who, "[mutating] create-checkout refuses another member's charge", `HTTP ${fn.status}`);
    else R.fail(who, "[mutating] create-checkout refuses another member's charge", `HTTP ${fn.status}`);
  }
  if (otherAttempt) {
    const ret = await client.fn('payment-return', { reference: otherAttempt.reference });
    if (!ret || ret.error) R.inconclusive(who, "[mutating] payment-return hides another member's payment", 'network error');
    else if (ret.status === 200 && ret.json?.status === 'not-found') R.pass(who, "[mutating] payment-return hides another member's payment");
    else if (ret.status >= 500) R.inconclusive(who, "[mutating] payment-return hides another member's payment", `HTTP ${ret.status}`);
    else R.fail(who, "[mutating] payment-return hides another member's payment", `HTTP ${ret.status}, ${ret.json?.status ?? 'no status'}`);
  }
  judgeHttp(R, who, '[mutating] process-payments refuses a member session', await client.fn('process-payments', {}), 401);
}

/**
 * The whole run. `signIn(label)` returns { client } or { error }.
 * Order: officer sign-in and baseline first; members only after.
 */
export async function runChecks({ anon, signIn, anonOnly = false, unlinkedOnly = false, includeMutating = false, log = () => {} }) {
  const R = new Results(log);
  if (!includeMutating) R.notRun.push(...MUTATING_PROBES);
  R.notRun.push(`${NOT_PROBED_LIVE.join(', ')}: not called live; covered by the database tests`);

  if (anonOnly) {
    await checkAnonymous(R, anon, null);
    return R;
  }

  let officer = null;
  let baseline = null;
  const off = await signIn('Officer');
  if (off.client) {
    R.pass('Officer', 'sign in');
    officer = off.client;
    baseline = await readBaseline(R, officer);
  } else {
    R.fail('Officer', 'sign in', off.error ?? 'failed');
  }
  const before = baseline ? fingerprint(baseline) : null;

  if (unlinkedOnly) {
    if (!baseline) {
      R.skip('Unlinked', 'all unlinked-account checks', 'officer sign-in or baseline reads did not succeed');
    } else {
      const u = await signIn('Unlinked account');
      if (!u.client) { R.fail('Unlinked', 'sign in', u.error ?? 'failed'); R.skip('Unlinked', 'all unlinked-account checks', 'not signed in'); }
      else {
        R.pass('Unlinked', 'sign in');
        await checkUnlinked(R, u.client, baseline);
        await u.client.signOut?.();
      }
    }
    await finalComparison(R, officer, before);
    await officer?.signOut?.();
    return R;
  }

  await checkAnonymous(R, anon, baseline);
  if (officer) await checkOfficer(R, officer);

  for (const k of Object.keys(MEMBERS)) {
    const who = `Member ${k}`;
    if (!baseline) {
      R.skip(who, 'all member checks', 'officer sign-in or baseline reads did not succeed');
      continue;
    }
    const s = await signIn(who);
    if (!s.client) { R.fail(who, 'sign in', s.error ?? 'failed'); R.skip(who, 'all member checks', 'not signed in'); continue; }
    R.pass(who, 'sign in');
    await checkMember(R, k, s.client, baseline);
    if (includeMutating) await mutatingProbes(R, k, s.client, baseline);
    await s.client.signOut?.();
  }

  await finalComparison(R, officer, before);
  await officer?.signOut?.();
  return R;
}

async function finalComparison(R, officer, before) {
  if (officer && before) {
    const after = await readBaseline(new Results(), officer);
    if (!after) R.inconclusive('Officer', 'records unchanged by the checks', 'could not re-read the records');
    else if (fingerprint(after) === before) R.pass('Officer', 'records unchanged by the checks');
    else R.fail('Officer', 'records unchanged by the checks', 'payment, charge, officer, levy or task records changed');
  } else {
    R.skip('Officer', 'records unchanged by the checks', 'no baseline');
  }
}
