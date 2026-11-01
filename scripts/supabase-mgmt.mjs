// Applies migrations and the fictional seed to a Supabase TEST project through
// the documented Management API (https://api.supabase.com/api/v1-json):
//   POST /v1/projects/{ref}/database/migrations   apply one migration (recorded in history)
//   GET  /v1/projects/{ref}/database/migrations   list applied migrations
//   POST /v1/projects/{ref}/database/query        run SQL (used for the seed)
//
// Authentication: SUPABASE_ACCESS_TOKEN if set, otherwise none is added (for
// environments whose network proxy injects it). Response bodies are never
// printed in full; only names, counts and error messages.
//
// Node's fetch reads HTTPS_PROXY only with NODE_USE_ENV_PROXY=1 (Node >= 22.21).
//
//   node scripts/supabase-mgmt.mjs <project-ref> status
//   node scripts/supabase-mgmt.mjs <project-ref> migrate [--dry-run]
//   node scripts/supabase-mgmt.mjs <project-ref> seed
//
// The Management API assigns its own version to each applied migration; the
// migration name is the local file name without its version prefix and .sql.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [ref, command, flag] = process.argv.slice(2);
if (!/^[a-z]{20}$/.test(ref ?? '') || !['status', 'migrate', 'seed'].includes(command)) {
  console.error('Usage: node scripts/supabase-mgmt.mjs <project-ref> status|migrate [--dry-run]|seed');
  process.exit(1);
}
const base = `https://api.supabase.com/v1/projects/${ref}`;
const headers = { 'content-type': 'application/json' };
if (process.env.SUPABASE_ACCESS_TOKEN) headers.authorization = `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`;

async function api(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { ...headers, ...extraHeaders }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const message = (json && (json.message || json.error)) || `HTTP ${res.status}`;
    throw new Error(`${method} ${path} failed: HTTP ${res.status}: ${String(typeof message === 'string' ? message : JSON.stringify(message)).slice(0, 400)}`);
  }
  return json;
}

const local = readdirSync(join(ROOT, 'supabase/migrations'))
  .filter((f) => /^\d{14}_.+\.sql$/.test(f))
  .sort()
  .map((file) => ({ file, name: file.replace(/^\d{14}_/, '').replace(/\.sql$/, ''), version: file.slice(0, 14) }));

const applied = await api('GET', '/database/migrations');
const appliedNames = new Set(applied.map((m) => m.name));
const pending = local.filter((m) => !appliedNames.has(m.name));

if (command === 'status') {
  console.log(`Remote migrations: ${applied.length}. Local: ${local.length}. Pending: ${pending.map((m) => m.file).join(', ') || 'none'}.`);
  process.exit(0);
}

if (command === 'migrate') {
  if (pending.length === 0) {
    console.log('No pending migrations.');
    process.exit(0);
  }
  for (const m of pending) {
    const sql = readFileSync(join(ROOT, 'supabase/migrations', m.file), 'utf8');
    if (flag === '--dry-run') {
      console.log(`Would apply ${m.file} as "${m.name}" (${sql.length} characters).`);
      continue;
    }
    // The idempotency key makes a retried request track the migration only once.
    await api('POST', '/database/migrations', { query: sql, name: m.name }, { 'Idempotency-Key': `community-ledger-${m.version}-${m.name}` });
    console.log(`Applied ${m.file}.`);
  }
  if (flag === '--dry-run') process.exit(0);
  const after = await api('GET', '/database/migrations');
  console.log(`Remote migrations now: ${after.map((m) => `${m.version} ${m.name}`).join('; ')}`);
  process.exit(0);
}

if (command === 'seed') {
  if (pending.length) {
    console.error(`Refusing to seed: ${pending.length} migration(s) not applied yet.`);
    process.exit(1);
  }
  const [{ members }] = await api('POST', '/database/query', { query: 'select count(*)::int as members from public.members', read_only: true });
  if (members > 0) {
    console.error(`Refusing to seed: public.members already has ${members} row(s). The seed is for an empty test database.`);
    process.exit(1);
  }
  await api('POST', '/database/query', { query: readFileSync(join(ROOT, 'supabase/seed.sql'), 'utf8') });
  console.log('Seed applied (fictional records).');
}
