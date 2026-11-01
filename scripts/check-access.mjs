// Access-boundary checks against the Supabase TEST project with genuine
// sign-in sessions (the same public API and publishable key as the app).
//
//   node scripts/check-access.mjs                          officer, members A-D and anonymous
//   node scripts/check-access.mjs --anon                   anonymous checks only (no sign-in)
//   node scripts/check-access.mjs --include-mutating-probes   also the probes listed below
//
// The default run is NOT purely read-only: it calls officer and server
// operations as members and anonymously. Each one used was checked so that it
// changes nothing even if its authorization check were missing (see
// PRIVILEGED_SAFE and WRITES in access-check-lib.mjs). At the end the officer
// re-reads the records and the run fails if any payment, charge, officer, levy
// or task record changed.
//
// --include-mutating-probes adds probes that WOULD change live data if the
// authorization they test were broken (creating a payment attempt for another
// member's charge, asking the provider about another member's payment, running
// the payment worker). They are off by default.
//
// Reads VITE_SUPABASE_URL, VITE_SUPABASE_PUBLISHABLE_KEY and (optionally)
// VITE_SUPABASE_FUNCTIONS_URL from the environment or .env.local. Asks for each
// account's email and password; the password is not echoed. Passwords and
// session tokens stay in memory: nothing is written to disk, and the output
// shows only results, counts and error codes.
//
// Exit codes: 0 all passed; 1 a check failed; 3 incomplete (some checks were
// inconclusive or skipped); 2 configuration error.
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { createClient } from '@supabase/supabase-js';
import { runChecks } from './access-check-lib.mjs';

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
const args = new Set(process.argv.slice(2));
for (const a of args) {
  if (!['--anon', '--include-mutating-probes'].includes(a)) {
    console.error(`Unknown option ${a}`);
    process.exit(2);
  }
}

const muted = new Writable({ write: (_c, _e, cb) => cb() });
async function ask(question, hidden = false) {
  process.stdout.write(question);
  const rl = createInterface({ input: process.stdin, output: hidden ? muted : process.stdout, terminal: true });
  const answer = await new Promise((resolve) => rl.question('', resolve));
  rl.close();
  if (hidden) process.stdout.write('\n');
  return answer.trim();
}

const networkError = (e) => ({ data: null, error: { message: e instanceof Error ? e.message : 'network error', code: '' }, status: 0 });

/** Wraps a supabase-js client in the small interface the checks use. */
function adapter(sb) {
  const run = async (q) => {
    try {
      const { data, error, status } = await q;
      return { data, error, status };
    } catch (e) {
      return networkError(e);
    }
  };
  return {
    select(table, { columns = '*', eq, limit } = {}) {
      let q = sb.from(table).select(columns);
      if (eq) q = q.eq(eq[0], eq[1]);
      if (limit) q = q.limit(limit);
      return run(q);
    },
    write(w) {
      const t = sb.from(w.table);
      if (w.op === 'insert') return run(t.insert(w.values));
      if (w.op === 'update') return run(t.update(w.values).eq(w.eq[0], w.eq[1]));
      return run(t.delete().eq(w.eq[0], w.eq[1]));
    },
    rpc(fn, params) {
      return run(sb.rpc(fn, params));
    },
    async fn(name, body) {
      try {
        const { data } = await sb.auth.getSession();
        const token = data.session?.access_token;
        const res = await fetch(`${FUNCTIONS}/${name}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: KEY, ...(token ? { authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        return { status: res.status, json };
      } catch {
        return { error: 'network' };
      }
    },
    async signOut() {
      try {
        await sb.auth.signOut();
      } catch {
        /* the session ends with the process anyway */
      }
    },
  };
}

const client = () => createClient(URL_, KEY, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });

async function signIn(label) {
  console.log('');
  const email = await ask(`${label} email: `);
  const password = await ask(`${label} password (hidden): `, true);
  const sb = client();
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) return { error: `sign-in refused (${error.status ?? '?'} ${error.code ?? ''})`.trim() };
  } catch {
    return { error: 'network error' };
  }
  return { client: adapter(sb) };
}

console.log(`Access checks against ${new URL(URL_).host} (test project). Output shows results only.`);
if (args.has('--include-mutating-probes')) {
  console.log('Including probes that would change data if authorization were broken.');
}
const results = await runChecks({
  anon: adapter(client()),
  signIn,
  anonOnly: args.has('--anon'),
  includeMutating: args.has('--include-mutating-probes'),
  log: (line) => console.log(line),
});
console.log(`\n${results.summary()}`);
process.exit(results.exitCode());
