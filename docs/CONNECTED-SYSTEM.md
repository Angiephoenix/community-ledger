# Connected test setup

Use a dedicated Supabase project with fictional records and a Paystack test account. Start with the [demo](../README.md#try-the-demo) to explore the interface without credentials. See the [test results](TEST-RESULTS.md) for the scenarios exercised against the hosted test services.

## Checkout behavior

The database refuses a new payment for a charge while an earlier **submitted**
payment for it is still being checked (inside the 48-hour reminder pause). Once
that earlier payment has gone unconfirmed past the pause, the member may pay
again, but only by choosing **Pay again** (`p_pay_again`); the screen explains
that if both go through the extra is kept as credit for an officer to review.
Starting a new checkout closes any older checkout for the same charges that was
opened but never submitted. Attempts for one member are created one at a time.

## Payment flow

1. The signed-in member reads their own records through the Supabase Data API. The checkout function starts a payment attempt for the selected charges and returns the Paystack test checkout URL.
2. Paystack sends a signed webhook. The handler validates the signature, stores the event once, and acknowledges it before handing off background processing.
3. The return handler can check the attempt with Paystack if it has yet to be resolved. The worker picks up stored events, retries unfinished work and reconciles attempts that need another check.
4. Verified test payments post in one database transaction. A reference mismatch creates a review task. The same worker also delivers queued analytics events to PostHog if analytics is configured.

### Function authentication

| Function | `verify_jwt` | In-function check | Who can call it |
| --- | --- | --- | --- |
| `create-checkout` | `true` | `auth: 'user'`, issuer pinned to this project | A signed-in member |
| `payment-return` | `true` | `auth: 'user'`, issuer pinned | A signed-in member, for their own reference only |
| `payment-webhook` | `false` | Provider signature over the raw body | The payment provider |
| `process-payments` | `false` | `auth: 'secret:cron'` | Only a request carrying the project secret key named `cron` in the `apikey` header |

`verify_jwt = false` is set only where the function authenticates another way
and checks that credential itself. This matches Supabase's "Securing Edge
Functions" and "Function configuration" guides: keep
`verify_jwt` on for user-facing functions; for cron or worker calls with a
secret key on `apikey`, turn it off and use `auth: 'secret:<name>'` (named keys
are created under Settings > API keys); for external webhooks, use
`auth: 'none'`, verify the provider's signature in the handler and keep
`verify_jwt = false`. Tested under Deno: the
worker answers 200 to `apikey: <cron key>` alone, and 401 to no key, a wrong
key, the default secret key and a member JWT. A signed webhook with no Supabase
credential reaches its handler.

`@supabase/server` accepts only the newer key formats (`sb_publishable_…`,
`sb_secret_…`) and asymmetric JWT signing keys. The test project must use them.

## Configuration

Never put a secret in a `VITE_` variable, in chat, in an issue or in a commit.
`.env.example` lists the names only.

| Variable | Where it goes | Public or secret | Purpose |
| --- | --- | --- | --- |
| `VITE_APP_MODE` | Browser build (`.env.local`) | Public | `connected` for the test system; anything else builds the standalone demo |
| `VITE_SUPABASE_URL` | Browser build | Public | Project URL, `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Browser build | Public | The project's publishable key (`sb_publishable_…`). RLS protects the data, not this key |
| `VITE_SUPABASE_FUNCTIONS_URL` | Browser build (optional) | Public | Only if functions are not at `<URL>/functions/v1` |
| `VITE_POSTHOG_HOST` | Browser build (optional) | Public | PostHog ingestion host for the **test** project, e.g. `https://eu.i.posthog.com` |
| `VITE_POSTHOG_PROJECT_KEY` | Browser build (optional) | Public | PostHog test project's project API key (designed to be public) |
| `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS` | Provided to Edge Functions **by the Supabase platform** | Secret (secret keys) | Used by `@supabase/server`. Do not set them yourself |
| `APP_ORIGIN` | Edge Function secret | Not sensitive | Where the app runs, e.g. `http://localhost:5173`. Used for CORS and the checkout return URL |
| `PAYMENT_PROVIDER` | Edge Function secret | Not sensitive | `paystack` |
| `PAYSTACK_SECRET_KEY` | Edge Function secret | **Secret** | Paystack **test** secret key. Never a live key |
| `POSTHOG_HOST` | Edge Function secret (optional) | Not sensitive | Same ingestion host as above, for server events |
| `POSTHOG_PROJECT_KEY` | Edge Function secret (optional) | Public key, kept server-side here | Same project key, for server events |
| `SUPABASE_URL` | Your machine (scripts) | Public | For `scripts/create-test-users.mjs` |
| `SUPABASE_SECRET_KEY` | Your machine (scripts) | **Secret** | A project secret key, for creating and linking test accounts |
| `SUPABASE_CRON_KEY` | Your machine and the database Vault | **Secret** | The project secret key named `cron`, used to call the worker |
| `TEST_USER_PASSWORD` | Your machine (scripts) | **Secret** | Password for the fictional test accounts |
| `TEST_USER_EMAIL_DOMAIN` | Your machine (scripts) | Not sensitive | A domain you control for test-account emails |
| `POSTHOG_APP_HOST`, `POSTHOG_PROJECT_ID` | Your machine (verification) | Not sensitive | e.g. `https://eu.posthog.com` and the test project's id |
| `POSTHOG_PERSONAL_API_KEY` | Your machine (verification) | **Secret** | Personal API key with Query Read, for `scripts/verify-posthog.mjs` |

## Commands

### Local checks (no credentials)

```bash
npm ci
```

```bash
npm test
```

```bash
npm run test:db
```

```bash
npm run check:functions
```

```bash
npm run build
```

`test:db` needs PostgreSQL server binaries (default `/usr/lib/postgresql/16/bin`,
override with `PG_BIN`). It also runs the Deno tests for the Edge Function
handlers through the `deno` dev dependency.

### Hosted test project

Use the Supabase CLI installed from the lockfile. Replace `<project-ref>` with your own test project reference. The commands below assume a fresh database, a reachable PostgreSQL connection, and permission to deploy functions and manage secrets.

1. Sign in to the CLI (opens a browser) and link the test project:

```bash
npx supabase login
```

```bash
npx supabase link --project-ref <project-ref>
```

2. Preview, then apply the migrations and the fictional seed:

```bash
npx supabase db push --dry-run
```

```bash
npx supabase db push --include-seed
```

3. Review, then push the auth settings in `supabase/config.toml` (self sign-up off, site URL `http://localhost:5173`):

```bash
npx supabase config diff
```

```bash
npx supabase config push
```

4. Put the Edge Function secrets in `supabase/functions/.env` (git-ignored; the same file the local stack reads). Use the server-side names in the configuration table. Then:

```bash
npx supabase secrets set --env-file supabase/functions/.env
```

5. Deploy. The member functions keep the platform JWT check; the webhook and worker turn it off (also declared in `config.toml`):

```bash
npx supabase functions deploy create-checkout payment-return
```

```bash
npx supabase functions deploy payment-webhook process-payments --no-verify-jwt
```

6. Create the fictional test accounts (reads `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `TEST_USER_PASSWORD`, `TEST_USER_EMAIL_DOMAIN`; prints no secrets):

```bash
node scripts/create-test-users.mjs
```

7. Create a Supabase secret key named `cron` and load it into `SUPABASE_CRON_KEY` in your shell. Use it to call the worker once:

```bash
curl -sS -X POST "https://<project-ref>.supabase.co/functions/v1/process-payments" -H "apikey: $SUPABASE_CRON_KEY"
```

8. Schedule the worker every minute, following Supabase’s [scheduling guide](https://supabase.com/docs/guides/functions/schedule-functions) (`pg_cron` + `pg_net` + Vault). First enable the two extensions as the Supabase docs show (or from the dashboard):

```sql
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
```

Then store the two Vault entries and create the schedule in the SQL editor of the **test** project, pasting the `cron` secret key there yourself, never in chat:

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<the secret key named cron>', 'cron_secret_key');
select cron.schedule(
  'process-payments-every-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/process-payments',
    headers := jsonb_build_object(
      'Content-type', 'application/json',
      'apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  ) as request_id;
  $$
);
```

9. To run the app, set these values in a git-ignored `.env.local` file and restart Vite. Use the accounts from step 6.

```dotenv
VITE_APP_MODE=connected
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=<your-project-publishable-key>
```

```bash
npm run dev
```

10. In the [Paystack dashboard](https://paystack.com/docs/payments/webhooks/), select **Test Mode** and set the webhook URL to `https://<project-ref>.supabase.co/functions/v1/payment-webhook`. Use the same Paystack test secret key for checkout, verification and webhook signature validation.

11. If you configured both sides of the optional PostHog integration, run the test payment journey and check what PostHog received:

```bash
node scripts/verify-posthog.mjs 24
```

It reads back what the PostHog **test** project stored and gives one verdict
for the analytics checks:

| Verdict | Exit | When |
| --- | --- | --- |
| verified | 0 | All five test events arrived (`payment started`, `payment confirmed`, `statement viewed`, `receipt viewed`, `discrepancy reported`); at least one member's `payment started` was followed by `payment confirmed` within 24 hours; nothing sensitive was stored; every PostHog-added property has been reviewed |
| failed | 2 | Any sensitive property, whatever its prefix (`$ip`, `$geoip_*`, `$email`, `$current_url`, `$pathname`, `$referrer`, user agent, names, phone numbers, references, amounts and similar), any other unexpected non-`$` property, a sensitive value (email address, IP address, `CL-` reference, member name) under any property, or a `distinct_id` that is not an opaque `an_…` id |
| needs-review | 4 | PostHog added a property that is not sensitive but has not been reviewed |
| incomplete | 3 | No events, a required event missing, or no completed funnel |
| error | 1 | The query failed, returned no rows object, or the review file was rejected |

**Reviewing a PostHog-added property.** Look at what it contains in the test
project. If it carries nothing about a person, add an entry to
`scripts/posthog-reviewed-properties.json` and commit it:

```json
[{ "name": "$lib", "reason": "Library name added by PostHog; no personal data", "reviewedBy": "Project maintainer", "reviewedOn": "2026-11-01" }]
```

Sensitive properties cannot be accepted this way; the script rejects such a
file. If PostHog stores one (for example `$ip` or `$geoip_*`), change the
PostHog project's IP-capture setting and test again rather than accepting it.

The analytics journey must therefore include viewing a statement, opening a
receipt and reporting a (fictional) problem, as well as paying.

A **verified** result covers the analytics checks for the queried time window.

12. Check access boundaries with the fictional accounts from the repository folder, with `.env.local` in place:

```bash
node scripts/check-access.mjs
```

It asks for the officer's email and password first (the password is not
shown as you type) and reads, as the officer, what exists. Only then does it
run the anonymous checks and sign in as each member. It tries to read other
members' records and officer data, and calls a set of officer and server
operations whose code paths were checked to change nothing even if their
authorization check were missing (listed in `scripts/access-check-lib.mjs`).
At the end the officer re-reads the payment, charge, officer, levy and task
records and the run fails if any changed.

The default run is therefore **not purely read-only**, but it is designed not
to change data. Each result is PASS, FAIL, INCONCLUSIVE (for example a network
or server error, or an empty answer when there was nothing to hide) or SKIPPED
(a prerequisite failed: if the officer cannot sign in or the baseline reads
fail, every member check is skipped). Exit code 0 means every check passed; 1
means a check failed; 3 means the run was incomplete.

Not called by the live checker: `server_claim_provider_events` and
`server_claim_analytics_events` (they claim at least one row even with a limit
of 0), and the other server and officer jobs that would change data if their
check failed. Their refusal is covered by the database tests
(`tests/db/access.test.ts`) and the grant inventory, not by live evidence.

`--include-mutating-probes` adds four probes that **would change live data if
the authorization they test were broken**: starting a payment or a checkout for
another member's charge, asking `payment-return` about another member's
payment, and calling the payment worker with a member session. They are off by
default. `--anon` runs only the anonymous part, which needs no sign-in.
`--unlinked` signs in the officer (to see what exists) and then an account
with no member link and no officer role, and checks with that account's own
session that every table and view is refused or empty and every privileged
operation refused (`report_discrepancy` and the checkout probes are not
called). A table with no rows at all cannot show that anything is hidden, so
it is reported INCONCLUSIVE and the run ends INCOMPLETE (exit 3); a fresh seeded project has an empty adjustments table, so expect that result there.
Output is results and counts only; passwords and session tokens are never
printed or saved.

Run it directly in a terminal: it refuses to read passwords from a pipe. Each
prompt shows `<Account> email:` (what you type is shown) and then
`<Account> password (typing is hidden):` (nothing is shown, not even dots;
Backspace and Ctrl-U work). Ctrl-C at any time, or Ctrl-D on an empty prompt,
stops the run with exit code 130 and gives the terminal back.
