-- Community Ledger · core schema
--
-- Money is integer kobo (bigint). Balances are never stored: they are derived
-- from charges, allocations and adjustments. Every uniqueness key that stops a
-- rerun creating duplicates is a database constraint, not just application code.
--
-- Schemas
--   public : records members and officers may read (row-level security filters
--            them) and the functions the API may call.
--   app    : internal tables and helpers. Not exposed through the API.

create schema if not exists app;
revoke all on schema app from public;

create type public.member_status as enum ('active', 'inactive');
create type public.reminder_channel as enum ('whatsapp', 'email', 'none');
create type public.attempt_status as enum ('started', 'abandoned', 'pending', 'confirmed', 'failed');
create type public.outbox_kind as enum ('reminder-due-soon', 'reminder-overdue', 'new-charge');
create type public.outbox_status as enum ('scheduled', 'cancelled', 'previewed');
create type public.task_type as enum ('unapplied-credit', 'held-event', 'unresolved-payment', 'invalid-rule', 'discrepancy', 'event-failed');
create type public.task_status as enum ('open', 'reviewed', 'resolved');

create table public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- One row of configuration. The environment is fixed to 'test' in milestone 2:
-- payment posting refuses anything else.
create table app.settings (
  singleton boolean primary key default true check (singleton),
  group_id uuid not null references public.organisations (id),
  environment text not null default 'test' check (environment = 'test'),
  -- Demo/test clock for scenario dates. Only honoured while environment = 'test'.
  clock_override timestamptz,
  due_soon_fraction numeric not null default 0.75 check (due_soon_fraction > 0 and due_soon_fraction < 1),
  pending_pause interval not null default interval '48 hours',
  assess_ahead_days integer not null default 10 check (assess_ahead_days >= 0),
  receipt_prefix text not null default 'RCT',
  -- Which payment provider new attempts use. 'paystack' in the connected test
  -- system; automated tests use a labelled fake provider.
  payment_provider text not null default 'paystack'
);

create table public.members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.organisations (id),
  display_name text not null check (length(display_name) between 1 and 120),
  status public.member_status not null default 'active',
  joined_on date not null,
  reminder_channel public.reminder_channel not null default 'whatsapp',
  -- Purpose-specific opaque analytics id. Pseudonymous, not anonymous.
  analytics_id text not null unique default ('an_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)),
  -- Sign-in account. Set only by a trusted server operation.
  user_id uuid unique references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);

-- Officer status lives here, never in user-editable auth metadata.
create table public.officers (
  user_id uuid primary key references auth.users (id) on delete cascade,
  group_id uuid not null references public.organisations (id),
  granted_at timestamptz not null default now(),
  granted_by text not null
);

create table public.dues_rules (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.organisations (id),
  code text not null unique,
  name text not null,
  amount_kobo bigint not null check (amount_kobo > 0),
  frequency text not null check (frequency in ('annual', 'monthly')),
  issue_day text not null, -- annual 'MM-DD', monthly 'DD'
  due_day text not null,
  first_period text not null, -- 'YYYY' or 'YYYY-MM'
  created_at timestamptz not null default now()
);

create table public.levies (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.organisations (id),
  name text not null check (length(name) between 1 and 120),
  amount_kobo bigint not null check (amount_kobo > 0),
  issue_date date not null,
  due_date date not null,
  status text not null default 'published' check (status in ('draft', 'published')),
  published_at timestamptz,
  created_by uuid,
  check (due_date >= issue_date)
);

create table public.levy_targets (
  levy_id uuid not null references public.levies (id) on delete cascade,
  member_id uuid not null references public.members (id),
  primary key (levy_id, member_id)
);

-- One member's debt for one rule period or levy. `key` stops reruns duplicating it.
create table public.charges (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.organisations (id),
  key text not null unique,
  member_id uuid not null references public.members (id),
  source_type text not null check (source_type in ('rule', 'levy')),
  rule_id uuid references public.dues_rules (id),
  period text,
  levy_id uuid references public.levies (id),
  title text not null,
  amount_kobo bigint not null check (amount_kobo > 0),
  issue_date date not null,
  due_date date not null,
  created_at timestamptz not null default now(),
  check (due_date >= issue_date),
  check ((source_type = 'rule' and rule_id is not null and period is not null and levy_id is null)
      or (source_type = 'levy' and levy_id is not null and rule_id is null))
);
create index charges_member_idx on public.charges (member_id);

-- Explicit corrections or waivers. Signed: negative reduces the debt.
create table public.adjustments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.organisations (id),
  charge_id uuid not null references public.charges (id),
  amount_kobo bigint not null check (amount_kobo <> 0),
  reason text not null check (length(reason) between 3 and 500),
  created_by uuid,
  created_at timestamptz not null default now()
);
create index adjustments_charge_idx on public.adjustments (charge_id);

-- The member's intent to pay, saved before checkout opens.
create table public.payment_attempts (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.organisations (id),
  reference text not null unique check (reference ~ '^[A-Za-z0-9-]{6,64}$'),
  member_id uuid not null references public.members (id),
  amount_kobo bigint not null check (amount_kobo > 0),
  currency char(3) not null default 'NGN' check (currency = 'NGN'),
  status public.attempt_status not null default 'started',
  provider text not null,
  environment text not null default 'test' check (environment = 'test'),
  authorization_url text,
  checkout_opened_at timestamptz,
  closed_reason text,
  verification_checks integer not null default 0,
  last_checked_at timestamptz,
  last_provider_status text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index payment_attempts_member_idx on public.payment_attempts (member_id);

create table public.payment_attempt_charges (
  attempt_id uuid not null references public.payment_attempts (id) on delete cascade,
  charge_id uuid not null references public.charges (id),
  primary key (attempt_id, charge_id)
);
create index payment_attempt_charges_charge_idx on public.payment_attempt_charges (charge_id);

-- A confirmed incoming payment. One row per provider transaction.
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.organisations (id),
  provider text not null,
  provider_ref text not null,
  provider_transaction_id text,
  attempt_id uuid references public.payment_attempts (id),
  member_id uuid not null references public.members (id),
  amount_kobo bigint not null check (amount_kobo > 0),
  currency char(3) not null default 'NGN' check (currency = 'NGN'),
  environment text not null default 'test' check (environment = 'test'),
  source text not null check (source in ('provider', 'opening-record')),
  paid_at timestamptz,
  confirmed_at timestamptz not null default now(),
  fee_kobo bigint check (fee_kobo is null or fee_kobo >= 0),
  -- Confirmation is not bank settlement; settlement is not tracked yet.
  settlement text not null default 'not-tracked',
  unique (provider, provider_ref)
);
create index payments_member_idx on public.payments (member_id);

create table public.allocations (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id),
  charge_id uuid not null references public.charges (id),
  amount_kobo bigint not null check (amount_kobo > 0),
  created_at timestamptz not null default now(),
  unique (payment_id, charge_id)
);
create index allocations_charge_idx on public.allocations (charge_id);

create sequence app.receipt_seq;

create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null unique references public.payments (id),
  member_id uuid not null references public.members (id),
  number text not null unique,
  issued_at timestamptz not null default now(),
  amount_kobo bigint not null check (amount_kobo > 0),
  unapplied_kobo bigint not null default 0 check (unapplied_kobo >= 0)
);

-- Preview-only message queue. Nothing is sent in milestone 2.
create table public.outbox_messages (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  member_id uuid not null references public.members (id),
  charge_id uuid not null references public.charges (id),
  kind public.outbox_kind not null,
  channel public.reminder_channel not null check (channel <> 'none'),
  body text not null,
  status public.outbox_status not null default 'scheduled',
  status_reason text,
  superseded_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index outbox_messages_charge_idx on public.outbox_messages (charge_id);

-- Items for officers in Needs attention.
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  type public.task_type not null,
  member_id uuid references public.members (id),
  ref_id text,
  title text not null,
  detail text not null,
  status public.task_status not null default 'open',
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  close_note text,
  closed_by uuid
);

create table public.job_runs (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  ran_at timestamptz not null default now(),
  summary text not null,
  details jsonb not null default '[]'::jsonb,
  run_by uuid
);

-- Append-only history of every financial change and job run.
create table public.audit_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor text not null,
  actor_user uuid,
  action text not null,
  detail text not null
);

-- Payment-provider events. Recorded durably before the webhook is acknowledged,
-- then processed (and retried) separately. Unique per provider event.
create table app.provider_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  dedupe_key text not null,
  event_type text not null,
  reference text,
  payload jsonb not null,
  received_at timestamptz not null default now(),
  status text not null default 'received' check (status in ('received', 'processing', 'processed', 'held', 'ignored', 'failed')),
  attempts integer not null default 0,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  outcome text,
  processed_at timestamptz,
  unique (provider, dedupe_key)
);

-- Server-side analytics events written in the same transaction as the change
-- they describe, so an event exists only if that change committed. `id` is
-- sent as the event uuid and `occurred_at` as its timestamp on every retry.
create table app.analytics_outbox (
  id uuid primary key default gen_random_uuid(),
  event_key text not null unique,
  event text not null check (event in ('payment started', 'payment confirmed', 'discrepancy reported')),
  distinct_id text not null,
  properties jsonb not null,
  occurred_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  sent_at timestamptz
);
