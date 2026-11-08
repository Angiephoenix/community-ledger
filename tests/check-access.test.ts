import { describe, expect, it } from 'vitest';
import {
  classify, judgeHidden, judgeRefused, judgeHttp, MEMBERS, OFFICER_ONLY, PRIVILEGED_SAFE, Results, runChecks,
} from '../scripts/access-check-lib.mjs';

// A fake of the public API that behaves like the real test project (RLS,
// grants, refusals) and can be told to misbehave. No network.

type Row = Record<string, unknown>;
type Res = { data?: unknown; error?: { code: string; message: string } | null; status?: number };
const denied: Res = { data: null, error: { code: '42501', message: 'permission denied' }, status: 403 };
const network: Res = { data: null, error: { code: '', message: 'TypeError: fetch failed' }, status: 0 };

const chargeId = (k: string, n: number) => `ch-${k}-${n}`;
function world() {
  const rows: Record<string, Row[]> = {
    members: Object.values(MEMBERS).map((id) => ({ id })),
    charges: ['a', 'b', 'c'].flatMap((k) => [1, 2, 3].map((n) => ({ id: chargeId(k, n), member_id: MEMBERS[k.toUpperCase() as 'A' | 'B' | 'C'] }))),
    payment_attempts: [
      { id: 'at-a', member_id: MEMBERS.A, status: 'confirmed', amount_kobo: 500000, reference: 'OPENING-1' },
      { id: 'at-b', member_id: MEMBERS.B, status: 'confirmed', amount_kobo: 3500000, reference: 'CL-B' },
      { id: 'at-c', member_id: MEMBERS.C, status: 'pending', amount_kobo: 2000000, reference: 'CL-C' },
    ],
    payments: [{ id: 'p-a', member_id: MEMBERS.A }, { id: 'p-b', member_id: MEMBERS.B }],
    receipts: [{ id: 'r-a', member_id: MEMBERS.A }, { id: 'r-b', member_id: MEMBERS.B }],
    allocations: [{ id: 'al-a', charge_id: chargeId('a', 1) }, { id: 'al-b', charge_id: chargeId('b', 1) }],
    adjustments: [],
    payment_attempt_charges: [{ attempt_id: 'at-a', charge_id: chargeId('a', 1) }, { attempt_id: 'at-c', charge_id: chargeId('c', 1) }],
    organisations: [{ id: 'g' }],
    dues_rules: [{ id: 'rule' }],
    officers: [{ user_id: 'officer-user' }],
    levies: [{ id: 'lv' }],
    levy_targets: [{ levy_id: 'lv' }],
    outbox_messages: [{ id: 'o' }],
    tasks: [{ id: 't', status: 'open' }],
    job_runs: [{ id: 'j' }],
    audit_events: [{ id: 1 }],
  };
  rows.charge_balances = rows.charges.map((c) => ({ ...c }));
  rows.member_balances = Object.values(MEMBERS).map((id) => ({ member_id: id }));
  rows.payment_attempt_overview = rows.payment_attempts.map((a) => ({ ...a }));
  return rows;
}

interface Faults {
  /** Table -> response returned for every select on it. */
  select?: Record<string, Res>;
  /** Table -> response for member sessions only. */
  memberSelect?: Record<string, Res>;
  /** Tables a member can read in full (an RLS leak). */
  leak?: string[];
  /** RPC name -> response (e.g. a validation error meaning authorization is missing). */
  rpc?: Record<string, Res>;
  officerSignIn?: 'refused' | 'network';
  unlinkedSignIn?: 'refused';
  /** Called before the final officer re-read. */
  beforeFinal?: (rows: Record<string, Row[]>) => void;
  finalRead?: Res;
}

function fakeApi(f: Faults = {}) {
  const rows = world();
  const calls: { who: string; kind: string; name: string; args?: unknown }[] = [];
  const ownerOf = (t: string, r: Row) => {
    if ('member_id' in r) return r.member_id;
    if (t === 'members') return r.id;
    if ('attempt_id' in r) return rows.payment_attempts.find((a) => a.id === r.attempt_id)?.member_id;
    if ('charge_id' in r) return rows.charges.find((c) => c.id === r.charge_id)?.member_id;
    return undefined;
  };
  const memberTables = new Set(['members', 'charges', 'payment_attempts', 'payments', 'receipts', 'allocations', 'adjustments',
    'payment_attempt_charges', 'charge_balances', 'member_balances', 'payment_attempt_overview']);
  let officerReads = 0;

  function client(who: 'anon' | 'officer' | 'unlinked' | keyof typeof MEMBERS) {
    const memberId = who === 'anon' || who === 'officer' || who === 'unlinked' ? null : MEMBERS[who];
    return {
      async select(table: string, o: { eq?: [string, unknown] } = {}): Promise<Res> {
        calls.push({ who, kind: 'select', name: table });
        if (who === 'officer' && table === 'members') officerReads += 1;
        if (who === 'officer' && officerReads > 1 && f.beforeFinal) { f.beforeFinal(rows); f.beforeFinal = undefined; }
        if (who === 'officer' && officerReads > 1 && f.finalRead) return f.finalRead;
        if (f.select?.[table]) return f.select[table];
        if (memberId && f.memberSelect?.[table]) return f.memberSelect[table];
        if (who === 'anon') return denied;
        let out = rows[table] ?? [];
        if (who !== 'officer') {
          if (OFFICER_ONLY.includes(table)) out = [];
          // Like the real policies: with no member link, shared tables are hidden too.
          else if (who === 'unlinked' && !(f.leak ?? []).includes(table)) out = [];
          else if (memberTables.has(table) && !(f.leak ?? []).includes(table)) out = out.filter((r) => ownerOf(table, r) === memberId);
        }
        if (o.eq) out = out.filter((r) => r[o.eq![0]] === o.eq![1]);
        return { data: out, error: null, status: 200 };
      },
      async write(w: { op: string; table: string }): Promise<Res> {
        calls.push({ who, kind: 'write', name: `${w.op} ${w.table}` });
        return denied;
      },
      async rpc(fn: string, args: Record<string, unknown>): Promise<Res> {
        calls.push({ who, kind: 'rpc', name: fn, args });
        if (f.rpc?.[fn]) return f.rpc[fn];
        if (fn === 'whoami') return who === 'anon' ? denied : { data: { member_id: memberId, is_officer: who === 'officer' }, error: null, status: 200 };
        if (fn === 'collection_report' && who === 'officer') return { data: {}, error: null, status: 200 };
        if (fn === 'my_payment_attempt') {
          const a = rows.payment_attempts.find((x) => x.reference === args.p_reference && x.member_id === memberId);
          return { data: a ?? null, error: null, status: 200 };
        }
        return denied;
      },
      async fn(name: string): Promise<{ status: number; json?: Record<string, unknown> }> {
        calls.push({ who, kind: 'fn', name });
        if (name === 'create-checkout') return who === 'anon' ? { status: 401 } : { status: 400, json: { ok: false, message: 'A member can only pay their own charges.' } };
        if (name === 'payment-return') return { status: 200, json: { status: 'not-found' } };
        return { status: 401 };
      },
      async signOut() {},
    };
  }
  const signIn = async (label: string) => {
    calls.push({ who: label, kind: 'signin', name: label });
    if (label === 'Officer') {
      if (f.officerSignIn === 'refused') return { error: 'sign-in refused (400 invalid_credentials)' };
      if (f.officerSignIn === 'network') return { error: 'network error' };
      return { client: client('officer') };
    }
    if (label === 'Unlinked account') return f.unlinkedSignIn === 'refused' ? { error: 'sign-in refused (400 invalid_credentials)' } : { client: client('unlinked') };
    return { client: client(label.replace('Member ', '') as 'A') };
  };
  return { anon: client('anon'), signIn, calls, rows };
}

const statusOf = (R: Results, who: string, name: string) => R.items.find((i) => i.who === who && i.name === name)?.status;

describe('classify', () => {
  it('separates success, authorization refusals, validation errors and everything else', () => {
    expect(classify({ data: [], error: null, status: 200 }).kind).toBe('ok');
    expect(classify(denied).kind).toBe('denied');
    expect(classify({ error: { code: '22023', message: 'x' }, status: 400 }).kind).toBe('validation');
    expect(classify({ error: { code: '23502', message: 'x' }, status: 400 }).kind).toBe('validation');
    expect(classify(network)).toEqual({ kind: 'unexpected', detail: 'network or client error' });
    expect(classify({ error: { code: 'PGRST301', message: 'JWT expired' }, status: 401 }).kind).toBe('unexpected');
    expect(classify({ error: { code: 'PGRST202', message: 'function not found' }, status: 404 }).kind).toBe('unexpected');
    expect(classify({ error: { code: '42P01', message: 'relation does not exist' }, status: 404 }).kind).toBe('unexpected');
    expect(classify({ data: null, error: null, status: 503 }).kind).toBe('unexpected');
    expect(classify(undefined).kind).toBe('unexpected');
  });
});

describe('judgements never turn an error into a PASS', () => {
  it('reads: refusal passes; empty passes only when rows exist to hide; errors are inconclusive; rows fail', () => {
    const R = new Results();
    judgeHidden(R, 'x', 'denied', denied, 3);
    judgeHidden(R, 'x', 'empty with rows', { data: [], error: null, status: 200 }, 3);
    judgeHidden(R, 'x', 'empty, nothing exists', { data: [], error: null, status: 200 }, 0);
    judgeHidden(R, 'x', 'empty, no baseline', { data: [], error: null, status: 200 }, null);
    judgeHidden(R, 'x', 'network', network, 3);
    judgeHidden(R, 'x', 'server error', { data: null, error: { code: 'XX000', message: 'internal' }, status: 500 }, 3);
    judgeHidden(R, 'x', 'leak', { data: [{ id: 1 }], error: null, status: 200 }, 3);
    expect(R.items.map((i) => i.status)).toEqual(['PASS', 'PASS', 'INCONCLUSIVE', 'INCONCLUSIVE', 'INCONCLUSIVE', 'INCONCLUSIVE', 'FAIL']);
  });
  it('refusals: only 42501 passes; reaching validation or being allowed fails; other errors are inconclusive', () => {
    const R = new Results();
    judgeRefused(R, 'x', 'denied', denied);
    judgeRefused(R, 'x', 'validation', { error: { code: '22023', message: 'Give the levy a name.' }, status: 400 });
    judgeRefused(R, 'x', 'allowed', { data: {}, error: null, status: 200 });
    judgeRefused(R, 'x', 'network', network);
    judgeRefused(R, 'x', 'missing function', { error: { code: 'PGRST202', message: 'not found' }, status: 404 });
    expect(R.items.map((i) => i.status)).toEqual(['PASS', 'FAIL', 'FAIL', 'INCONCLUSIVE', 'INCONCLUSIVE']);
  });
  it('HTTP: expected status passes, 5xx and network errors are inconclusive, anything else fails', () => {
    const R = new Results();
    judgeHttp(R, 'x', 'ok', { status: 401 }, 401);
    judgeHttp(R, 'x', 'down', { status: 503 }, 401);
    judgeHttp(R, 'x', 'net', { error: 'network' }, 401);
    judgeHttp(R, 'x', 'open', { status: 200 }, 401);
    expect(R.items.map((i) => i.status)).toEqual(['PASS', 'INCONCLUSIVE', 'INCONCLUSIVE', 'FAIL']);
  });
});

describe('runChecks', () => {
  it('a table with nothing in it cannot prove hiding: inconclusive, not PASS', async () => {
    const R = await runChecks(fakeApi()); // no adjustments in this fixture
    expect(R.counts()).toMatchObject({ FAIL: 0, SKIPPED: 0 });
    const inconclusive = R.items.filter((i) => i.status === 'INCONCLUSIVE').map((i) => i.name);
    expect(inconclusive.length).toBeGreaterThan(0);
    expect(inconclusive.every((n) => /adjustments/.test(n))).toBe(true);
    expect(R.exitCode()).toBe(3);
  });

  it('with adjustments present everything passes and the exit code is 0', async () => {
    const api = fakeApi();
    api.rows.adjustments.push({ id: 'adj-b', charge_id: chargeId('b', 2) }, { id: 'adj-a', charge_id: chargeId('a', 2) });
    const R = await runChecks(api);
    expect(R.counts()).toMatchObject({ FAIL: 0, INCONCLUSIVE: 0, SKIPPED: 0 });
    expect(R.exitCode()).toBe(0);
    expect(R.summary()).toMatch(/Result: all checks passed/);
  });

  it('a network failure on a read is inconclusive, never PASS, and the run is incomplete', async () => {
    const api = fakeApi({ select: { payments: network } });
    const R = await runChecks(api);
    expect(statusOf(R, 'Officer', 'baseline read payments')).toBe('INCONCLUSIVE');
    expect(statusOf(R, 'anonymous', 'read payments')).toBe('INCONCLUSIVE');
    expect(R.items.some((i) => i.name === 'read payments' && i.status === 'PASS')).toBe(false);
    expect(R.exitCode()).not.toBe(0);
  });

  it('an unrelated server or query error on a member read is inconclusive', async () => {
    const R = await runChecks(fakeApi({ memberSelect: { receipts: { data: null, error: { code: '42703', message: 'column does not exist' }, status: 400 } } }));
    expect(statusOf(R, 'Member A', 'read receipts: only own rows')).toBe('INCONCLUSIVE');
    expect(R.exitCode()).toBe(3);
  });

  it("a member who can read another member's rows fails", async () => {
    const R = await runChecks(fakeApi({ leak: ['charges'] }));
    expect(statusOf(R, 'Member A', 'read charges: only own rows')).toBe('FAIL');
    expect(statusOf(R, 'Member A', "cannot read other members' charges by id")).toBe('FAIL');
    expect(R.exitCode()).toBe(1);
  });

  it('a privileged operation that reaches validation fails (authorization did not stop it)', async () => {
    const R = await runChecks(fakeApi({ rpc: { publish_levy: { error: { code: '22023', message: 'Give the levy a name.' }, status: 400 } } }));
    expect(statusOf(R, 'Member B', 'publish_levy refused')).toBe('FAIL');
    expect(statusOf(R, 'anonymous', 'publish_levy refused')).toBe('FAIL');
  });

  it('if the officer cannot sign in, every member check is skipped and the run fails', async () => {
    for (const mode of ['refused', 'network'] as const) {
      const api = fakeApi({ officerSignIn: mode });
      const R = await runChecks(api);
      expect(statusOf(R, 'Officer', 'sign in')).toBe('FAIL');
      for (const k of ['A', 'B', 'C', 'D']) expect(statusOf(R, `Member ${k}`, 'all member checks')).toBe('SKIPPED');
      expect(statusOf(R, 'Officer', 'records unchanged by the checks')).toBe('SKIPPED');
      // No member was even asked to sign in, and no member probe ran.
      expect(api.calls.filter((c) => c.kind === 'signin').map((c) => c.name)).toEqual(['Officer']);
      // Anonymous empty-or-refused reads still run; refusals pass, nothing is assumed about empty ones.
      expect(R.exitCode()).toBe(1);
      expect(R.summary()).toMatch(/failed, .* inconclusive, [1-9]\d* skipped/);
    }
  });

  it('if an officer baseline read fails, member checks are skipped', async () => {
    const api = fakeApi({ select: { tasks: { data: null, error: { code: '', message: 'fetch failed' }, status: 0 } } });
    const R = await runChecks(api);
    expect(statusOf(R, 'Officer', 'baseline read tasks')).toBe('INCONCLUSIVE');
    expect(statusOf(R, 'Member A', 'all member checks')).toBe('SKIPPED');
    expect(api.calls.some((c) => c.who === 'A')).toBe(false);
    expect(R.exitCode()).toBe(3);
  });

  it('the final comparison fails if records changed and is inconclusive if it cannot read', async () => {
    const changed = await runChecks(fakeApi({ beforeFinal: (rows) => rows.payment_attempts.push({ id: 'new', member_id: MEMBERS.B, status: 'started', amount_kobo: 1, reference: 'CL-NEW' }) }));
    expect(statusOf(changed, 'Officer', 'records unchanged by the checks')).toBe('FAIL');
    const unread = await runChecks(fakeApi({ finalRead: network }));
    expect(statusOf(unread, 'Officer', 'records unchanged by the checks')).toBe('INCONCLUSIVE');
    expect(unread.exitCode()).toBe(3);
  });

  it('the default run never calls the claim functions or any mutating probe', async () => {
    const api = fakeApi();
    const R = await runChecks(api);
    const names = api.calls.map((c) => c.name);
    for (const n of ['server_claim_provider_events', 'server_claim_analytics_events', 'server_set_test_clock', 'server_link_member_user',
      'server_post_verified_payment', 'run_recurring_assessment', 'run_reminder_job', 'deliver_reminder_previews', 'payment-return', 'process-payments']) {
      expect(names, n).not.toContain(n);
    }
    // start_payment_attempt is only called with an id that is nobody's charge, and create-checkout only without a session.
    const starts = api.calls.filter((c) => c.name === 'start_payment_attempt');
    const realCharges = new Set(api.rows.charges.map((c) => c.id));
    for (const s of starts) expect((s.args as { p_charge_ids: string[] }).p_charge_ids.some((id) => realCharges.has(id))).toBe(false);
    expect(api.calls.filter((c) => c.name === 'create-checkout').every((c) => c.who === 'anon')).toBe(true);
    expect(PRIVILEGED_SAFE.map(([n]) => n)).not.toContain('server_claim_provider_events');
    expect(R.summary()).toMatch(/Not run \(could change data/);
    expect(R.summary()).toMatch(/start_payment_attempt for another member's charge/);
  });

  it('mutating probes run only when asked for, and are labelled', async () => {
    const api = fakeApi();
    api.rows.adjustments.push({ id: 'adj-b', charge_id: chargeId('b', 2) }, { id: 'adj-a', charge_id: chargeId('a', 2) });
    const R = await runChecks({ ...api, includeMutating: true });
    expect(api.calls.some((c) => c.name === 'payment-return')).toBe(true);
    expect(R.items.filter((i) => i.name.startsWith('[mutating]')).length).toBeGreaterThan(0);
    expect(R.summary()).not.toMatch(/start_payment_attempt for another member's charge \(would/);
    expect(R.exitCode()).toBe(0);
  });

  it('--anon: refusals pass; with no baseline an empty read is inconclusive', async () => {
    const ok = await runChecks({ ...fakeApi(), anonOnly: true });
    expect(ok.counts()).toMatchObject({ FAIL: 0, INCONCLUSIVE: 0, SKIPPED: 0 });
    const empty = await runChecks({ ...fakeApi({ select: { tasks: { data: [], error: null, status: 200 } } }), anonOnly: true });
    expect(statusOf(empty, 'anonymous', 'read tasks')).toBe('INCONCLUSIVE');
    expect(empty.exitCode()).toBe(3);
  });

  it('--unlinked: an account with no member link reads nothing and is refused everything', async () => {
    const api = fakeApi();
    api.rows.adjustments.push({ id: 'adj-b', charge_id: chargeId('b', 2) });
    const R = await runChecks({ ...api, unlinkedOnly: true });
    expect(R.counts()).toMatchObject({ FAIL: 0, INCONCLUSIVE: 0, SKIPPED: 0 });
    expect(statusOf(R, 'Unlinked', 'whoami: no member link, not an officer')).toBe('PASS');
    expect(statusOf(R, 'Unlinked', 'read dues_rules')).toBe('PASS');
    expect(statusOf(R, 'Unlinked', 'start_payment_attempt refused')).toBe('PASS');
    expect(statusOf(R, 'Officer', 'records unchanged by the checks')).toBe('PASS');
    // Only the officer and the unlinked account sign in; no member, no anonymous checks.
    expect(api.calls.filter((c) => c.kind === 'signin').map((c) => c.name)).toEqual(['Officer', 'Unlinked account']);
    expect(api.calls.some((c) => c.who === 'anon')).toBe(false);
    for (const n of ['report_discrepancy', 'create-checkout', 'payment-return', 'process-payments']) expect(api.calls.map((c) => c.name)).not.toContain(n);
    expect(R.exitCode()).toBe(0);
  });

  it('--unlinked: a visible row fails, and a refused officer sign-in skips the account', async () => {
    const leak = await runChecks({ ...fakeApi({ leak: ['dues_rules'] }), unlinkedOnly: true });
    expect(statusOf(leak, 'Unlinked', 'read dues_rules')).toBe('FAIL');
    expect(leak.exitCode()).toBe(1);
    const api = fakeApi({ officerSignIn: 'refused' });
    const skipped = await runChecks({ ...api, unlinkedOnly: true });
    expect(statusOf(skipped, 'Unlinked', 'all unlinked-account checks')).toBe('SKIPPED');
    expect(api.calls.filter((c) => c.kind === 'signin').map((c) => c.name)).toEqual(['Officer']);
    expect(skipped.exitCode()).toBe(1);
  });

  it('--unlinked with an empty adjustments table (as on the live project): one honest INCONCLUSIVE, exit 3', async () => {
    const R = await runChecks({ ...fakeApi(), unlinkedOnly: true }); // the fixture has no adjustments
    const inconclusive = R.items.filter((i) => i.status === 'INCONCLUSIVE');
    expect(inconclusive.map((i) => `${i.who}: ${i.name}`)).toEqual(['Unlinked: read adjustments']);
    expect(inconclusive[0].detail).toBe('empty, but there are no rows to hide');
    expect(R.counts()).toMatchObject({ FAIL: 0, SKIPPED: 0, INCONCLUSIVE: 1 });
    expect(R.exitCode()).toBe(3);
    expect(R.summary()).toMatch(/Result: INCOMPLETE/);
  });
});

