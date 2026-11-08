// A tiny stand-in for the Supabase test project, for driving the real
// check-access CLI in a pseudo-terminal. Dummy accounts only; nothing here is a
// real credential. It answers the same shapes as Supabase Auth, PostgREST and
// the Edge Functions gateway:
//   - POST /auth/v1/token?grant_type=password with a known dummy email and
//     password returns a dummy session; anything else is 400 invalid_credentials
//   - the officer token reads fixture rows; every other caller gets 42501
//   - Edge Functions answer 401
import { createServer } from 'node:http';

export const MEMBER_IDS = {
  A: '00000000-0000-4000-8000-00000000000a',
  B: '00000000-0000-4000-8000-00000000000b',
  C: '00000000-0000-4000-8000-00000000000c',
  D: '00000000-0000-4000-8000-00000000000d',
};

/** label -> { email, password, token } (dummy values for tests only). */
export const ACCOUNTS = {
  Officer: { email: 'officer@example.test', password: 'dummy-officer-pass-1', token: 'stub-token-officer-SECRETMARK' },
  'Member A': { email: 'a@example.test', password: 'dummy-member-pass-A', token: 'stub-token-a-SECRETMARK' },
  'Member B': { email: 'b@example.test', password: 'dummy-member-pass-B', token: 'stub-token-b-SECRETMARK' },
  'Member C': { email: 'c@example.test', password: 'dummy-member-pass-C', token: 'stub-token-c-SECRETMARK' },
  'Member D': { email: 'd@example.test', password: 'dummy-member-pass-D', token: 'stub-token-d-SECRETMARK' },
};

const rows = {
  members: Object.values(MEMBER_IDS).map((id) => ({ id })),
  charges: [{ id: 'ch-a', member_id: MEMBER_IDS.A }, { id: 'ch-b', member_id: MEMBER_IDS.B }],
  payment_attempts: [{ id: 'at-c', member_id: MEMBER_IDS.C, status: 'pending', amount_kobo: 2000000, reference: 'CL-STUB' }],
  payments: [], receipts: [], allocations: [], adjustments: [], payment_attempt_charges: [],
  charge_balances: [], member_balances: Object.values(MEMBER_IDS).map((id) => ({ member_id: id })), payment_attempt_overview: [],
  organisations: [{ id: 'g' }], dues_rules: [], officers: [{ user_id: 'u-officer' }], levies: [], levy_targets: [],
  outbox_messages: [], tasks: [], job_runs: [], audit_events: [],
};

export function startStub() {
  const seen = { signIns: [], requests: 0 };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.requests += 1;
      const url = new URL(req.url, 'http://stub');
      const send = (status, json) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(json === undefined ? '' : JSON.stringify(json));
      };
      if (url.pathname === '/auth/v1/token') {
        let creds = {};
        try { creds = JSON.parse(body); } catch { /* bad body */ }
        const hit = Object.entries(ACCOUNTS).find(([, a]) => a.email === creds.email && a.password === creds.password);
        seen.signIns.push({ email: creds.email ?? null, ok: Boolean(hit) });
        if (!hit) return send(400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        const [, a] = hit;
        const now = Math.floor(Date.now() / 1000);
        return send(200, {
          access_token: a.token, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: `${a.token}-refresh`,
          user: { id: `user-${a.email}`, aud: 'authenticated', role: 'authenticated', email: a.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
        });
      }
      if (url.pathname === '/auth/v1/logout') return send(204);
      if (url.pathname.startsWith('/functions/v1/')) return send(401, { msg: 'unauthorized' });
      const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
      const officer = token === ACCOUNTS.Officer.token;
      const denied = () => send(token ? 403 : 401, { code: '42501', message: 'permission denied', details: null, hint: null });
      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const fn = url.pathname.slice('/rest/v1/rpc/'.length);
        if (officer && fn === 'whoami') return send(200, { member_id: null, is_officer: true });
        if (officer && fn === 'collection_report') return send(200, {});
        return denied();
      }
      if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.slice('/rest/v1/'.length);
        if (officer && req.method === 'GET' && rows[table]) return send(200, rows[table]);
        return denied();
      }
      return send(404, { message: 'not found' });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) }));
  });
}
