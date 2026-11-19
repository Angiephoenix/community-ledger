// Creates sign-in accounts for the fictional seed members and one officer in a
// Supabase TEST project, then links them using server-only database functions.
//
// Reads SUPABASE_URL, SUPABASE_SECRET_KEY (a project secret key, sb_secret_...),
// TEST_USER_PASSWORD and TEST_USER_EMAIL_DOMAIN from the environment.
// Never prints secret values.
// Run only against a test project:  node scripts/create-test-users.mjs
import { createClient } from '@supabase/supabase-js';

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Missing ${k}. Set it in your environment (its value is never printed).`);
    process.exit(1);
  }
  return v;
};

const url = need('SUPABASE_URL');
const serviceKey = need('SUPABASE_SECRET_KEY');
const password = need('TEST_USER_PASSWORD');
const domain = need('TEST_USER_EMAIL_DOMAIN');

const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

const accounts = [
  { email: `member-a@${domain}`, memberId: '00000000-0000-4000-8000-00000000000a' },
  { email: `member-b@${domain}`, memberId: '00000000-0000-4000-8000-00000000000b' },
  { email: `member-c@${domain}`, memberId: '00000000-0000-4000-8000-00000000000c' },
  { email: `member-d@${domain}`, memberId: '00000000-0000-4000-8000-00000000000d' },
  { email: `officer@${domain}`, officer: true },
];

for (const a of accounts) {
  const { data, error } = await admin.auth.admin.createUser({ email: a.email, password, email_confirm: true });
  let userId = data?.user?.id;
  if (error) {
    // Already exists: look it up instead.
    const { data: list, error: listError } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (listError) throw new Error(`Could not create or find ${a.email}: ${error.message}`);
    userId = list.users.find((u) => u.email === a.email)?.id;
    if (!userId) throw new Error(`Could not create ${a.email}: ${error.message}`);
  }
  if (a.memberId) {
    const { error: linkError } = await admin.rpc('server_link_member_user', { p_member_id: a.memberId, p_user_id: userId });
    if (linkError) throw new Error(`Could not link ${a.email}: ${linkError.message}`);
  }
  if (a.officer) {
    const { error: grantError } = await admin.rpc('server_grant_officer', { p_user_id: userId, p_granted_by: 'scripts/create-test-users.mjs' });
    if (grantError) throw new Error(`Could not grant officer to ${a.email}: ${grantError.message}`);
  }
  console.log(`Ready: ${a.email}${a.officer ? ' (officer)' : ''}`);
}
console.log('Test accounts are ready. Passwords were not printed.');
