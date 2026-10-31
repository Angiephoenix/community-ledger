# Connected test system (milestone 2)

Status as of 31 October 2026. Everything below is for a **test** environment with
fictional records. No live keys, real members, messages or public deployment.

## Status

| Area | Locally tested here | Externally verified | Blocked / not done |
| --- | --- | --- | --- |
| Database schema, migrations, seed | Applied to a fresh PostgreSQL 16 on every test run | Not applied to a Supabase project | Needs a Supabase test project |
| Access control (grants, RLS, functions, views) | Yes, using a Supabase-compatible shim (roles, `auth.uid()`, default grants) | Not checked on Supabase itself | supabase.com docs were not reachable to re-check current platform details |
| Sign-in | Sign-in, unreachable-server and unconfigured screens in the browser | No | Needs a Supabase project and test accounts |
| Payment pipeline (attempts, inbox, processing, posting, retries, reconciliation) | Yes, against the real database with a **fake** provider | No | Paystack adapter not written |
| Paystack test mode | Not implemented | No | paystack.com docs could not be read from this environment |
| PostHog | Exact outbound payloads tested with a fake network | No events sent to PostHog | Needs a PostHog test project key |
| Edge Functions (Deno entry points) | Not run or type-checked (no Deno here) | No | Thin wrappers; the code they call is tested |
| Scheduled processing | Logic tested | No schedule configured | Needs Supabase scheduling set up |

Fake-provider tests prove our own logic: what we do with a verified result. They
are not evidence about how Paystack behaves.

## How it fits together

```
Browser (signed-in member)
  ├─ reads its own rows through the Supabase API  ── RLS filters every table and view
  ├─ Pay ─► Edge Function create-checkout
  │          ├─ start_payment_attempt()  (member's JWT: own charges, amount from the database)
  │          ├─ provider: create hosted checkout page (no card details touch our code)
  │          └─ server_record_checkout_session()
  │       ◄─ redirect to the provider's page
  └─ returns ─► Edge Function payment-return ─► provider verify API ─► post if verified
                                        (the redirect itself never credits money)

Provider ─► Edge Function payment-webhook
              ├─ check signature (reject otherwise, store nothing)
              ├─ server_record_provider_event()   durable, deduplicated
              └─ 200 only after it is stored

Scheduled ─► Edge Function process-payments
              ├─ claim events (leases; a crashed worker's events are picked up again)
              ├─ provider verify API  (status, reference, amount, currency, test environment)
              ├─ server_post_verified_payment()   ONE transaction:
              │     payment + allocations + receipt + reminder cancellation
              │     + tasks + audit + "payment confirmed" analytics row
              ├─ reconcile attempts whose webhook never arrived
              └─ send queued analytics events to PostHog (retries; never affects payments)
```

Key rules, each enforced in the database and covered by `tests/db`:

- No API role (anon, authenticated, service_role) can insert, update or delete any table. Writes happen only through functions that check the caller.
- Members read only their own rows. Officer status comes from `public.officers`, never from editable user metadata.
- A provider transaction can create at most one payment (`unique (provider, provider_ref)`).
- Charges are locked in a fixed order while a payment is allocated, so concurrent payments never over-allocate. Excess becomes credit with a Needs attention task.
- Payments, allocations, receipts, adjustments and the audit trail are append-only.
- `app.settings.environment` must be `test`, and a payment reported as anything other than the provider's test environment is held, not credited.

## Configuration

`.env.example` lists the variable **names**. Put values in secure places only:

- Browser build (public values): `VITE_APP_MODE=connected`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, optional `VITE_POSTHOG_HOST`, `VITE_POSTHOG_PROJECT_KEY`.
- Edge Function secrets (server only): `SUPABASE_SERVICE_ROLE_KEY`, `PAYSTACK_SECRET_KEY` (test key), `CRON_SECRET`, `APP_ORIGIN`, `PAYMENT_PROVIDER`, `POSTHOG_HOST`, `POSTHOG_PROJECT_KEY`.
- Never put the service role key or Paystack secret in a `VITE_` variable, in chat, or in a commit.

## Running the checks locally

```bash
npm test
```

```bash
npm run test:db
```

`test:db` needs PostgreSQL 16 server binaries (default `/usr/lib/postgresql/16/bin`, override with `PG_BIN`). It starts a throwaway cluster, applies `tests/db/supabase-shim.sql`, every migration and the seed, and gives each test file a fresh copy.

## Setting up a Supabase test project (not yet done; commands not re-checked)

These are the usual Supabase CLI steps. They could not be checked against the
current Supabase docs from the build environment, so confirm them first.

1. Create a **test** Supabase project yourself. Do not reuse anything that holds real data.
2. Apply the migrations in `supabase/migrations` and then `supabase/seed.sql` (for example `supabase link` then `supabase db push`, and run the seed in the SQL editor).
3. Create test accounts: set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TEST_USER_PASSWORD` and `TEST_USER_EMAIL_DOMAIN` in your environment and run `node scripts/create-test-users.mjs`. It never prints secrets.
4. Deploy the four Edge Functions. `payment-webhook` must accept requests without a Supabase JWT; its security is the provider signature.
5. Schedule `process-payments` (for example every minute) with the `x-cron-secret` header.
6. Build the browser app with the `VITE_` values and `VITE_APP_MODE=connected`.

## What is needed to finish milestone 2

1. Allow `paystack.com` and `supabase.com` in this environment's network settings so the current official documentation can be read. Then implement and test the Paystack adapter (`supabase/functions/_shared/providers/index.ts`).
2. A Supabase **test** project, with its URL and keys added as environment secrets (not pasted into chat).
3. A Paystack **test-mode** secret key, added the same way.
4. Optional: a separate PostHog **test** project key and host.
