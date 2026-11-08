# Connected test system (milestone 2)

Status as of 1 November 2026 (updated after the network change). Everything here is for a **test** environment with
fictional records, test keys and preview-only messages. No live keys, real
members, messages or public deployment.

**Milestone 2 is not complete.** It completes only when every item in
section 6 has been verified against real test projects. The analytics verdict
is one of those items, not a substitute for the others.

## 1. Sources used

| Source | Reachable from the build environment? | Used for |
| --- | --- | --- |
| paystack.com documentation | **No.** Allowed by the network since 1 November, but every page answers HTTP 403 with a Cloudflare bot challenge (`cf-mitigated: challenge`). Not circumvented | Replaced by the first-party sources below |
| Paystack OpenAPI specification (`PaystackOSS/openapi`, `dist/paystack.yaml`, via raw.githubusercontent.com) | Yes | Base URL, bearer auth, initialise request and response (`amount` in the smallest unit, allowed `reference` characters), verify response fields (`id`, `domain`, `status`, `reference`, `amount`, `currency`, `paid_at`), 404 for unknown references |
| Paystack CLI (`@paystack-oss/dev-cli`, published by infrastructure@paystack.com), read as text | Yes | Webhook signature: `x-paystack-signature` is the hex HMAC-SHA512 of the request body keyed with the secret key; `charge.success` sample payload; `test` and `live` domains |
| api.paystack.co | Yes | Reached without a key: `401 {"code":"invalid_Key"}` as expected. No test-mode call yet (needs a test key) |
| supabase.com documentation | Yes, read 1 November | Function configuration, function auth, secrets, scheduling, background tasks (section 5 updated to match) |
| Supabase CLI 2.122.0 (official npm package `supabase`) | Yes | `config.toml` template and validation, every command in section 5 (checked with `--help`) |
| `@supabase/server` 1.9.2 (official npm package, docs included) | Yes | Function authentication model, `verify_jwt` guidance, platform environment variables |
| `@supabase/functions-js` 2.118.0 on jsr.io (official) | Yes | `EdgeRuntime.waitUntil` for background work after responding |
| `@paystack/paystack-sdk` 1.2.2 (official npm package) | Yes | Test secret keys look like `sk_test_…`; the adapter refuses any other key |
| posthog.com documentation | Yes | Capture API, event deduplication, funnels, person-less events, query API |
| PostHog ingestion and app hosts (`eu.i.posthog.com`, `us.i.posthog.com`, `eu.posthog.com`, `us.posthog.com`) | Yes, since 1 November (connections succeed; nothing sent yet) | Sending and reading back test events once a test project exists |
| Supabase Management API (`api.supabase.com`) | **No** | Needed by the CLI for `link`, `db push`, `secrets set` and `functions deploy` from this environment |

Not found in any source I could read: the complete list of Paystack verify `status` values and Paystack's webhook IP addresses. The adapter credits only `status = "success"`; every other value leaves balances untouched. Authenticity rests on the signature, not on IP addresses.

## 2. Status

| Area | Tested locally | Externally verified | Blocked or not done |
| --- | --- | --- | --- |
| Migrations and seed | Applied to a fresh PostgreSQL 16 on every test run | Yes: all five migrations and the seed applied to `community-ledger-test` (Postgres 17); see the log | — |
| Access control (grants, RLS, functions, views) | Yes, with a shim for Supabase's roles, `auth.uid()` and default grants | Largely: Angie's live run of `scripts/check-access.mjs` with all five sign-in sessions (8 November: 222 passed, 0 failed, 4 inconclusive, 0 skipped) | Adjustment isolation live (the table is empty; covered locally with a populated fixture); probes excluded from the live run (see step 12) |
| Payment pipeline (attempts, inbox, processing, posting, retries, reconciliation, mismatch holds) | Yes, real database plus a fake provider, and the real Paystack adapter against **simulated** Paystack HTTP | No | Paystack test key |
| Edge Function HTTP handlers | Yes: run under Deno 2.9.6 with the real `@supabase/server` auth gate and test-only keys | No | Supabase project |
| Supabase gateway (`verify_jwt` per function) | `config.toml` validated by the official CLI | Partly (check 3); see the log | Member-JWT requests are covered by the access checker |
| Paystack test mode | Adapter implemented from Paystack's OpenAPI spec and CLI; request building, response checks, signatures and the ledger pipeline tested with simulated HTTP | Only reachability (401 without a key) | A Paystack **test** secret key |
| PostHog | Exact outbound payloads tested; `verify-posthog.mjs` verdicts tested end to end against a local stand-in | No | PostHog test project, and its ingestion and app hosts allowed here |
| Sign-in screens | Sign-in, unreachable and unconfigured states in a browser | Yes, manually by Angie: Members A–D and the officer signed in and saw the expected pages and figures (screenshots, 1 November) | Unlinked-account screen (no unlinked test account exists) |

### One open payment per charge (connected system)

The database refuses a new payment for a charge while an earlier **submitted**
payment for it is still being checked (inside the 48-hour reminder pause). Once
that earlier payment has gone unconfirmed past the pause, the member may pay
again, but only by choosing **Pay again** (`p_pay_again`); the screen explains
that if both go through the extra is kept as credit for an officer to review.
Starting a new checkout closes any older checkout for the same charges that was
opened but never submitted. Attempts for one member are created one at a time.
The standalone demo keeps its milestone 1 behaviour (paying again is allowed at
any time and the excess becomes credit).

Fake-provider and fake-network tests prove our own logic. They are not evidence
about how Paystack or PostHog behave.

## 3. How it fits together

```
Browser (signed-in member, publishable key + user JWT)
  ├─ reads own rows through the Data API ── RLS filters every table and view
  ├─ Pay ─► create-checkout          [platform JWT check ON + auth: 'user', project issuer]
  │           ├─ start_payment_attempt()    as the member: own charges, amount from the database
  │           ├─ provider: hosted checkout page (no card details touch our code)
  │           └─ server_record_checkout_session()
  └─ returns ─► payment-return        [platform JWT check ON + auth: 'user']
                 └─ provider verify API ─► post only if verified (the redirect never credits)

Provider ─► payment-webhook           [platform JWT check OFF; provider signature checked in code]
              ├─ bad signature → 401, nothing stored
              ├─ server_record_provider_event()   durable, deduplicated; failure → 500
              ├─ 200 sent immediately after storing
              └─ EdgeRuntime.waitUntil(process events)   background, after the response

Scheduler ─► process-payments         [platform JWT check OFF; auth: 'secret:cron']
              ├─ claim stored events (leases; a crashed run's events are retried)
              ├─ provider verify API (status, reference, amount, currency, test environment)
              ├─ server_post_verified_payment()  ONE transaction: payment, allocations,
              │      receipt, reminder cancellation, tasks, audit, analytics row
              ├─ mismatched reference → one durable Needs attention task, nothing credited
              ├─ reconcile attempts whose webhook never arrived
              └─ deliver queued analytics events to PostHog (retries; never touches payments)
```

### Function authentication

| Function | `verify_jwt` | In-function check | Who can call it |
| --- | --- | --- | --- |
| `create-checkout` | `true` | `auth: 'user'`, issuer pinned to this project | A signed-in member |
| `payment-return` | `true` | `auth: 'user'`, issuer pinned | A signed-in member, for their own reference only |
| `payment-webhook` | `false` | Provider signature over the raw body | The payment provider |
| `process-payments` | `false` | `auth: 'secret:cron'` | Only a request carrying the project secret key named `cron` in the `apikey` header |

`verify_jwt = false` is set only where the function authenticates another way
and checks that credential itself. This matches Supabase's "Securing Edge
Functions" and "Function configuration" guides (read 1 November): keep
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

## 4. Configuration

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

## 5. Commands

### Local checks (no credentials)

```bash
npm install
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

Every command and flag below was checked against the official CLI 2.122.0
(`--help`). [TEST-PROJECT-LOG.md](TEST-PROJECT-LOG.md) records which have been
run against `community-ledger-test`, and where the documented Management API
was used instead (migrations, seed). Replace `<project-ref>`
with your **test** project's reference. Commands that need a secret read it from
your environment or a git-ignored file; never type a secret into chat.

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

4. Put the Edge Function secrets in `supabase/functions/.env` (git-ignored; the same file the local stack reads). Names come from section 4 and may not start with `SUPABASE_`. Then:

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

7. Call the worker once by hand. The key comes from your environment, not the command line:

```bash
curl -sS -X POST "https://<project-ref>.supabase.co/functions/v1/process-payments" -H "apikey: $SUPABASE_CRON_KEY"
```

8. Schedule the worker every minute, following Supabase's "Scheduling Edge Functions" guide (`pg_cron` + `pg_net` + Vault). First enable the two extensions as the Supabase docs show (or from the dashboard):

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

Supabase's guide notes that any database role that can log in can read the key in `net.http_request_queue` while a request waits. That is another reason to use a dedicated `cron` key that can be rotated on its own.

9. Build the app against the test project (values in a git-ignored `.env.local`):

```bash
npm run build
```

10. In the Paystack dashboard, in **test mode**, set the webhook URL to
`https://<project-ref>.supabase.co/functions/v1/payment-webhook`. The adapter
verifies `x-paystack-signature` with the test secret key, stores the event,
answers 200, and credits only after `GET /transaction/verify/{reference}`
confirms `status = success`, `domain = test`, the expected reference, amount
and NGN. (Where this setting sits in the dashboard could not be checked: the
paystack.com pages answer with a bot challenge.)

11. Check what PostHog received:

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
[{ "name": "$lib", "reason": "Library name added by PostHog; no personal data", "reviewedBy": "Angie Obiesie", "reviewedOn": "2026-11-01" }]
```

Sensitive properties cannot be accepted this way; the script rejects such a
file. If PostHog stores one (for example `$ip` or `$geoip_*`), change the
PostHog project's IP-capture setting and test again rather than accepting it.

The analytics journey must therefore include viewing a statement, opening a
receipt and reporting a (fictional) problem, as well as paying.

A **verified** result covers the analytics checks only. It does not complete
milestone 2; see section 6.

12. Check access boundaries with real sign-in sessions (check 2), on your own
computer from the repository folder, with `.env.local` in place:

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
Output is results and counts only; passwords and session tokens are never
printed or saved.

Run it directly in a terminal: it refuses to read passwords from a pipe. Each
prompt shows `<Account> email:` (what you type is shown) and then
`<Account> password (typing is hidden):` (nothing is shown, not even dots;
Backspace and Ctrl-U work). Ctrl-C at any time, or Ctrl-D on an empty prompt,
stops the run with exit code 130 and gives the terminal back.

## 6. Milestone 2 completion criteria

Milestone 2 is complete only when **every** item below has been verified
against the real test projects and the evidence recorded. Progress and
evidence are kept in [TEST-PROJECT-LOG.md](TEST-PROJECT-LOG.md). As of
8 November: migrations, seed, auth settings and the four functions are in
place on `community-ledger-test`; check 3 is verified; check 1 is verified
manually by Angie except for the unlinked-account screen; check 2 is verified
live with genuine sessions except for its recorded limitations (adjustment
isolation could not be shown live because the table is empty, and probes that
could change data were not run live); checks 4 to 7 have evidence from
Member A's hosted Paystack test payment (acknowledgement to Paystack
inferred, not read from Paystack's log); checks 8, 9 and 10 are not yet done. Local tests,
simulated provider responses and the analytics verdict on their own are not
enough.

| # | Check | Evidence |
| --- | --- | --- |
| 1 | **Sign-in:** each fictional member signs in and sees only their own dues; the officer sees all members; an unlinked account sees the "not linked" screen | Screens or responses per account |
| 2 | **Access boundaries on the live API:** Member A cannot read Member B's rows through the Data API; anonymous requests read nothing; no client can insert payments, allocations or receipts; members cannot call officer or server functions | Recorded API requests and their refusals |
| 3 | **Gateway:** `create-checkout` and `payment-return` refuse requests without a JWT; `payment-webhook` reaches its handler without one and rejects bad signatures; `process-payments` accepts only the `cron` key | Recorded requests and status codes |
| 4 | **Paystack test checkout:** Member A pays annual dues on Paystack's hosted test page | Paystack test transaction reference (not a card number) |
| 5 | **Webhook processing:** the signed `charge.success` is stored, acknowledged, verified with Paystack and posted | `app.provider_events` row and outcome |
| 6 | **Balances:** Member A's outstanding, overdue and upcoming figures change exactly as expected; the officer report checks all agree | Before/after figures |
| 7 | **Receipts and reminders:** one receipt for the payment; the matching unsent reminder cancelled | Receipt number; outbox row |
| 8 | **Duplicate handling:** a resent webhook and a second verification change nothing; two distinct payments for one charge keep the excess as credit with a Needs attention task | Counts before and after |
| 9 | **Failed and abandoned checkouts:** a declined test payment and a closed checkout credit nothing | Attempt statuses and balances |
| 10 | **Analytics:** `node scripts/verify-posthog.mjs 24` reports verified for the test project | Script output |
