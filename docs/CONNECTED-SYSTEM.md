# Connected test system (milestone 2)

Status as of 1 November 2026. Everything here is for a **test** environment with
fictional records, test keys and preview-only messages. No live keys, real
members, messages or public deployment.

**Milestone 2 is not complete.** It completes only when the connected sign-in,
payment and analytics journeys have been verified against real test projects.

## 1. Sources used

| Source | Reachable from the build environment? | Used for |
| --- | --- | --- |
| paystack.com documentation | **No** (host not allowed) | Needed before writing the Paystack adapter |
| api.paystack.co | **No** | Needed for any test-mode call |
| supabase.com documentation | **No** (host not allowed) | Could not be read |
| Supabase CLI 2.122.0 (official npm package `supabase`) | Yes | `config.toml` template and validation, every command in section 5 (checked with `--help`) |
| `@supabase/server` 1.9.2 (official npm package, docs included) | Yes | Function authentication model, `verify_jwt` guidance, platform environment variables |
| `@supabase/functions-js` 2.118.0 on jsr.io (official) | Yes | `EdgeRuntime.waitUntil` for background work after responding |
| `@paystack/paystack-sdk` 1.2.2 (official npm package) | Yes | Confirms only the API base URL, Bearer secret-key auth, and the initialise and verify endpoints. It does not describe webhook signatures or the verify response, so it is not enough to write the adapter |
| posthog.com documentation | Yes | Capture API, event deduplication, funnels, person-less events, query API |
| PostHog ingestion hosts (`eu.i.posthog.com`, `us.i.posthog.com`) | **No** | Needed to verify received events from here |

## 2. Status

| Area | Tested locally | Externally verified | Blocked or not done |
| --- | --- | --- | --- |
| Migrations and seed | Applied to a fresh PostgreSQL 16 on every test run | No | A Supabase test project (which runs Postgres 17) |
| Access control (grants, RLS, functions, views) | Yes, with a shim for Supabase's roles, `auth.uid()` and default grants | No | Supabase project |
| Payment pipeline (attempts, inbox, processing, posting, retries, reconciliation, mismatch holds) | Yes, real database plus a **fake** provider | No | Paystack adapter |
| Edge Function HTTP handlers | Yes: run under Deno 2.9.6 with the real `@supabase/server` auth gate and test-only keys | No | Supabase project |
| Supabase gateway (`verify_jwt` per function) | `config.toml` validated by the official CLI; gateway itself not run (needs Docker or a project) | No | Supabase project |
| Paystack test mode | Not implemented | No | paystack.com docs, then a test secret key |
| PostHog | Exact outbound payloads and the read-back checker tested with fakes | No | PostHog test project, and ingestion hosts allowed here |
| Sign-in screens | Sign-in, unreachable and unconfigured states in a browser | No | Supabase project and test accounts |

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
and checks that credential itself. That follows `@supabase/server`'s guidance:
the platform requires a valid JWT by default, and functions using a secret key
or no Supabase credential must turn that check off. Tested under Deno: the
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
(`--help`). None has been run against a project yet. Replace `<project-ref>`
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

4. Put the Edge Function secrets in a git-ignored file such as `supabase/.env.functions` (names from section 4), then:

```bash
npx supabase secrets set --env-file supabase/.env.functions
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

8. Schedule the worker every minute. This SQL uses `pg_cron`, `pg_net` and Vault. It is written from prior knowledge and **has not been checked against current Supabase docs**, so check it before running it in the SQL editor:

```sql
-- once: store the cron key in Vault (paste it in the SQL editor yourself, never in chat)
select vault.create_secret('<cron secret key>', 'process_payments_cron_key');
select cron.schedule('process-payments', '* * * * *', $$
  select net.http_post(
    url := 'https://<project-ref>.supabase.co/functions/v1/process-payments',
    headers := jsonb_build_object('apikey', (select decrypted_secret from vault.decrypted_secrets where name = 'process_payments_cron_key'))
  );
$$);
```

9. Build the app against the test project (values in a git-ignored `.env.local`):

```bash
npm run build
```

10. Paystack test dashboard: once the adapter exists, set the webhook URL to
`https://<project-ref>.supabase.co/functions/v1/payment-webhook`. (Details to
be confirmed from Paystack's docs.)

11. Check PostHog received the events and the funnel:

```bash
node scripts/verify-posthog.mjs 24
```

## 6. External verification still required

- **Sign-in:** each fictional member sees only their own dues; the officer sees all; an unlinked account sees the "not linked" screen.
- **Payment:** a Paystack test checkout for Member A's annual dues confirms through the webhook. Balance, receipt and reminder cancellation are correct. A repeated webhook changes nothing. A test failure and an abandoned checkout credit nothing.
- **Analytics:** `payment started` and `payment confirmed` arrive once each in the PostHog test project with only allowlisted properties, and the funnel shows the conversion.
- **Gateway:** `create-checkout` without a JWT is refused by the platform. `payment-webhook` and `process-payments` reach their handlers without a JWT and still enforce their own checks.
