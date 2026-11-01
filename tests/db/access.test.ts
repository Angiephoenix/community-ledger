import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { anon, freshDb, member, MEMBER, officer, service, type TestDb } from './harness';

// Access boundaries, checked at the database the way the Supabase API reaches it.

let db: TestDb;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db?.close(); });

const PRIVATE_TABLES = [
  'members', 'charges', 'adjustments', 'payment_attempts', 'payment_attempt_charges', 'payments', 'allocations',
  'receipts', 'outbox_messages', 'tasks', 'job_runs', 'audit_events', 'officers', 'levies', 'levy_targets',
  'dues_rules', 'organisations', 'charge_balances', 'member_balances', 'payment_attempt_overview',
];

const denied = async (p: Promise<unknown>) => {
  await expect(p).rejects.toThrow(/permission denied|Only officers|Server operation only|Sign in/);
};

describe('unauthenticated requests', () => {
  it.each(PRIVATE_TABLES)('anon cannot read %s', async (table) => {
    await denied(db.q(anon, `select * from public.${table}`));
  });

  it('anon cannot call member, officer or server functions', async () => {
    await denied(db.q(anon, `select public.start_payment_attempt(array[]::uuid[])`));
    await denied(db.q(anon, `select public.collection_report()`));
    await denied(db.q(anon, `select public.run_recurring_assessment()`));
    await denied(db.q(anon, `select public.server_post_verified_payment('paystack','x','y',1,'NGN',now(),null,'test')`));
  });

  it('anon cannot reach internal tables', async () => {
    for (const t of ['app.settings', 'app.provider_events', 'app.analytics_outbox']) await denied(db.q(anon, `select * from ${t}`));
  });
});

describe('Member A', () => {
  const A = () => member(db, 'A');

  it('sees only their own records in every table and view', async () => {
    for (const [table, col] of [
      ['members', 'id'], ['charges', 'member_id'], ['payment_attempts', 'member_id'], ['payments', 'member_id'],
      ['receipts', 'member_id'], ['charge_balances', 'member_id'], ['member_balances', 'member_id'], ['payment_attempt_overview', 'member_id'],
    ] as const) {
      const rows = await db.q<Record<string, string>>(A(), `select ${col} as m from public.${table}`);
      expect(rows.length, table).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.m)), table).toEqual(new Set([MEMBER.A]));
    }
    const allocs = await db.q<{ n: string }>(A(), `select count(*) as n from public.allocations a join public.payments p on p.id = a.payment_id where p.member_id <> $1`, [MEMBER.A]);
    expect(Number(allocs[0].n)).toBe(0);
  });

  it("cannot read Member B's records even by id", async () => {
    expect(await db.q(A(), `select * from public.members where id = $1`, [MEMBER.B])).toEqual([]);
    expect(await db.q(A(), `select * from public.charges where member_id = $1`, [MEMBER.B])).toEqual([]);
    expect(await db.q(A(), `select * from public.payments where member_id = $1`, [MEMBER.B])).toEqual([]);
    expect(await db.q(A(), `select * from public.member_balances where member_id = $1`, [MEMBER.B])).toEqual([]);
  });

  it('sees no officer-only records', async () => {
    for (const t of ['tasks', 'outbox_messages', 'audit_events', 'job_runs', 'officers', 'levies', 'levy_targets']) {
      expect(await db.q(A(), `select * from public.${t}`), t).toEqual([]);
    }
  });

  it('cannot run officer operations', async () => {
    await denied(db.q(A(), `select public.run_recurring_assessment()`));
    await denied(db.q(A(), `select public.run_reminder_job()`));
    await denied(db.q(A(), `select public.deliver_reminder_previews()`));
    await denied(db.q(A(), `select public.collection_report()`));
    await denied(db.q(A(), `select public.publish_levy('x', 100, '2026-11-24', '2026-12-01', array[$1]::uuid[])`, [MEMBER.A]));
    await denied(db.q(A(), `select public.add_adjustment(id, -100, 'waiver') from public.charges limit 1`));
    await denied(db.q(A(), `select public.record_opening_payment($1, id, 100, 'x') from public.charges limit 1`, [MEMBER.A]));
  });

  it('cannot call server-only functions', async () => {
    await denied(db.q(A(), `select public.server_post_verified_payment('paystack','x','y',1,'NGN',now(),null,'test')`));
    await denied(db.q(A(), `select public.server_grant_officer($1, 'me')`, [db.users.A]));
    await denied(db.q(A(), `select public.server_link_member_user($1, $2)`, [MEMBER.B, db.users.A]));
    await denied(db.q(A(), `select public.server_set_test_clock(now())`));
    await denied(db.q(A(), `select public.server_record_provider_event('paystack','k','charge.success','r','{}')`));
  });

  it("cannot start a payment for Member B's charges", async () => {
    const [bCharge] = await db.q<{ id: string }>({ kind: 'owner' }, `select id from public.charges where member_id = $1 limit 1`, [MEMBER.B]);
    await expect(db.q(A(), `select public.start_payment_attempt(array[$1]::uuid[])`, [bCharge.id])).rejects.toThrow(/own charges/);
  });

  it("cannot abandon Member C's pending payment", async () => {
    const [c] = await db.q<{ id: string }>({ kind: 'owner' }, `select id from public.payment_attempts where member_id = $1`, [MEMBER.C]);
    await expect(db.q(A(), `select public.abandon_payment_attempt($1)`, [c.id])).rejects.toThrow(/not found/);
  });
});

describe('fabricating financial records', () => {
  const tryWrites = (who: Parameters<TestDb['q']>[0]) => [
    () => db.q(who, `insert into public.payments (group_id, provider, provider_ref, member_id, amount_kobo, source) values (app.group_id(), 'paystack', 'FAKE', $1, 100, 'provider')`, [MEMBER.A]),
    () => db.q(who, `insert into public.allocations (payment_id, charge_id, amount_kobo) select p.id, c.id, 1 from public.payments p, public.charges c limit 1`),
    () => db.q(who, `insert into public.receipts (payment_id, member_id, number, amount_kobo) select id, member_id, 'FAKE-1', 1 from public.payments limit 1`),
    () => db.q(who, `update public.payment_attempts set status = 'confirmed'`),
    () => db.q(who, `update public.charges set amount_kobo = 1`),
    () => db.q(who, `delete from public.charges`),
    () => db.q(who, `insert into public.officers (user_id, group_id, granted_by) values (auth.uid(), app.group_id(), 'me')`),
    () => db.q(who, `update public.members set user_id = null`),
  ];

  it('members cannot insert, update or delete any financial table', async () => {
    for (const p of tryWrites(member(db, 'A'))) await expect(p()).rejects.toThrow(/permission denied/);
  });

  it('officers cannot write tables directly either', async () => {
    for (const p of tryWrites(officer(db))) await expect(p()).rejects.toThrow(/permission denied/);
  });

  it('server code also goes through functions, not direct writes', async () => {
    for (const p of tryWrites(service)) await expect(p()).rejects.toThrow(/permission denied/);
  });

  it('payments, allocations, receipts and the audit trail are append-only even for the owner', async () => {
    await expect(db.pool.query(`update public.payments set amount_kobo = 1`)).rejects.toThrow(/cannot be changed/);
    await expect(db.pool.query(`delete from public.allocations`)).rejects.toThrow(/cannot be changed/);
    await expect(db.pool.query(`delete from public.receipts`)).rejects.toThrow(/cannot be changed/);
    await expect(db.pool.query(`update public.audit_events set detail = 'x'`)).rejects.toThrow(/cannot be changed/);
  });

  it('nothing changed', async () => {
    const [r] = await db.q<{ p: string; a: string; r: string }>({ kind: 'owner' },
      `select (select count(*) from public.payments) p, (select count(*) from public.allocations) a, (select count(*) from public.receipts) r`);
    expect([r.p, r.a, r.r].map(Number)).toEqual([2, 4, 2]);
  });
});

describe('officer status', () => {
  it('comes from the officers table, not from user-editable metadata', async () => {
    const stranger = { kind: 'user' as const, userId: db.users.stranger, metadata: { role: 'officer', is_officer: true } };
    await denied(db.q(stranger, `select public.collection_report()`));
    expect(await db.q(stranger, `select * from public.charges`)).toEqual([]);
    expect(await db.q(stranger, `select * from public.tasks`)).toEqual([]);
  });

  it('a JWT claiming the service role inside an authenticated session gets nothing extra', async () => {
    // A user cannot mint a service_role JWT without the secret; the database role
    // is what matters. Here the role is authenticated even with a forged claim.
    const forged = await db.as({ kind: 'user', userId: db.users.A }, async (c) => {
      await c.query(`select set_config('request.jwt.claims', '{"sub":"${db.users.A}","role":"service_role"}', true)`);
      return c.query(`select public.server_set_test_clock(now())`).then(() => 'allowed', (e: Error) => e.message);
    });
    expect(forged).toMatch(/permission denied/);
  });

  it('officers can read every member and run officer operations', async () => {
    expect((await db.q(officer(db), `select * from public.members`)).length).toBe(4);
    const [r] = await db.q<{ report: { checks: { ok: boolean }[] } }>(officer(db), `select public.collection_report() as report`);
    expect(r.report.checks.every((c) => c.ok)).toBe(true);
  });

  it('officers still cannot call server-only functions', async () => {
    await denied(db.q(officer(db), `select public.server_post_verified_payment('paystack','x','y',1,'NGN',now(),null,'test')`));
    await denied(db.q(officer(db), `select public.server_grant_officer($1, 'me')`, [db.users.A]));
  });
});

describe('grants inventory', () => {
  it('no API role holds a write privilege on any table', async () => {
    const rows = await db.q<{ grantee: string; table_schema: string; table_name: string; privilege_type: string }>({ kind: 'owner' }, `
      select grantee, table_schema, table_name, privilege_type from information_schema.role_table_grants
      where grantee in ('anon','authenticated','service_role','PUBLIC') and table_schema in ('public','app')
        and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER')`);
    expect(rows).toEqual([]);
  });

  it('anon cannot execute any function in public or app', async () => {
    const rows = await db.q<{ fn: string }>({ kind: 'owner' }, `
      select p.oid::regprocedure::text as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public','app') and has_function_privilege('anon', p.oid, 'execute')`);
    expect(rows).toEqual([]);
  });

  it('every table has row-level security enabled', async () => {
    const rows = await db.q<{ t: string }>({ kind: 'owner' }, `
      select n.nspname || '.' || c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname in ('public','app') and not c.relrowsecurity`);
    expect(rows).toEqual([]);
  });

  it('views run with the caller’s permissions', async () => {
    const rows = await db.q<{ v: string; opts: string[] | null }>({ kind: 'owner' }, `
      select c.relname as v, c.reloptions as opts from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'v' and n.nspname = 'public'`);
    expect(rows.length).toBe(3);
    for (const r of rows) expect(r.opts, r.v).toContain('security_invoker=true');
  });
});

describe('claim functions (not probed by the live checker)', () => {
  // server_claim_provider_events and server_claim_analytics_events claim at
  // least one row (greatest(p_limit, 1)), so the live checker never calls them.
  // Their refusal is checked here against a database that has rows to claim.
  it('anonymous, member and officer sessions are refused and nothing is claimed', async () => {
    await db.q(service, `select public.server_record_provider_event('paystack', 'claim-check', 'charge.success', 'CL-NONE', '{}')`);
    await db.q({ kind: 'owner' }, `select app.queue_analytics('payment started', 'claim-check', $1)`, [MEMBER.A]);
    const snapshot = () => db.q<Record<string, unknown>>({ kind: 'owner' }, `select
      (select count(*) from app.provider_events where status <> 'received' or attempts > 0 or lease_until is not null) as provider_claimed,
      (select count(*) from app.provider_events) as provider_total,
      (select count(*) from app.analytics_outbox where status <> 'pending' or attempts > 0 or lease_until is not null) as analytics_claimed,
      (select count(*) from app.analytics_outbox) as analytics_total`);
    const [before] = await snapshot();
    expect(Number(before.provider_total)).toBeGreaterThan(0);
    expect(Number(before.analytics_total)).toBeGreaterThan(0);
    for (const who of [anon, member(db, 'A'), officer(db)]) {
      for (const limit of [0, 1]) {
        await denied(db.q(who, `select public.server_claim_provider_events($1, 60)`, [limit]));
        await denied(db.q(who, `select public.server_claim_analytics_events($1, 60)`, [limit]));
      }
    }
    expect(await snapshot()).toEqual([before]);
  });

  it('only the server role can execute any server_* function', async () => {
    const rows = await db.q<{ fn: string; role: string }>({ kind: 'owner' }, `
      select p.oid::regprocedure::text as fn, r.role from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      cross join (values ('anon'), ('authenticated'), ('service_role')) r(role)
      where n.nspname = 'public' and p.proname like 'server\\_%' and has_function_privilege(r.role, p.oid, 'execute')`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.role !== 'service_role')).toEqual([]);
    expect(rows.map((r) => r.fn)).toEqual(expect.arrayContaining(['server_claim_provider_events(integer,integer)', 'server_claim_analytics_events(integer,integer)']));
  });
});
