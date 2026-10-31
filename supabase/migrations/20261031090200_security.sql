-- Community Ledger · access control
--
-- 1. Start closed: revoke every default privilege the API roles may have.
-- 2. Members read only their own rows; officers read everything in the group.
--    Nobody using the API can INSERT/UPDATE/DELETE any table directly.
-- 3. Writes happen only through the functions granted below.
-- 4. service_role (server code) bypasses RLS but still has no direct table
--    writes: it uses the server_* functions too.

-- ---------------------------------------------------------------- 1. close everything

revoke all on all tables in schema public from public, anon, authenticated, service_role;
revoke all on all sequences in schema public from public, anon, authenticated, service_role;
revoke all on all functions in schema public from public, anon, authenticated, service_role;
revoke all on all tables in schema app from public, anon, authenticated, service_role;
revoke all on all sequences in schema app from public, anon, authenticated, service_role;
revoke all on all functions in schema app from public, anon, authenticated, service_role;

-- New objects created later start closed as well.
alter default privileges in schema public revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema public revoke all on functions from public, anon, authenticated, service_role;
alter default privileges in schema app revoke all on tables from public, anon, authenticated, service_role;
alter default privileges in schema app revoke all on functions from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------- 2. row-level security

alter table public.organisations enable row level security;
alter table public.members enable row level security;
alter table public.officers enable row level security;
alter table public.dues_rules enable row level security;
alter table public.levies enable row level security;
alter table public.levy_targets enable row level security;
alter table public.charges enable row level security;
alter table public.adjustments enable row level security;
alter table public.payment_attempts enable row level security;
alter table public.payment_attempt_charges enable row level security;
alter table public.payments enable row level security;
alter table public.allocations enable row level security;
alter table public.receipts enable row level security;
alter table public.outbox_messages enable row level security;
alter table public.tasks enable row level security;
alter table public.job_runs enable row level security;
alter table public.audit_events enable row level security;
alter table app.settings enable row level security;
alter table app.provider_events enable row level security;
alter table app.analytics_outbox enable row level security;

-- Read-only grants. RLS decides which rows.
grant usage on schema public to authenticated;
grant usage on schema app to authenticated, service_role;
grant select on public.organisations, public.members, public.officers, public.dues_rules, public.levies, public.levy_targets,
                public.charges, public.adjustments, public.payment_attempts, public.payment_attempt_charges, public.payments,
                public.allocations, public.receipts, public.outbox_messages, public.tasks, public.job_runs, public.audit_events,
                public.charge_balances, public.member_balances, public.payment_attempt_overview
  to authenticated;

-- Helpers used inside the read views and policies (read-only, no side effects).
grant execute on function app.now(), app.group_id(), app.due_soon_fraction(), app.pending_pause(), app.request_role(),
                         app.is_trusted(), app.current_member_id(), app.is_officer(), app.lagos_date(timestamptz),
                         app.day_start(date), app.due_cutoff(date), app.charge_allocated(uuid), app.charge_adjusted(uuid),
                         app.charge_outstanding(uuid), app.charge_status(uuid, timestamptz), app.payment_unapplied(uuid),
                         app.attempt_settled(uuid)
  to authenticated;

-- Policies. `(select ...)` lets Postgres evaluate the helper once per query.
create policy "members see their group" on public.organisations for select to authenticated
  using (id = (select app.group_id()) and ((select app.current_member_id()) is not null or (select app.is_officer())));

create policy "member reads own profile; officers read all" on public.members for select to authenticated
  using (id = (select app.current_member_id()) or (select app.is_officer()));

create policy "officers read officer list" on public.officers for select to authenticated
  using ((select app.is_officer()));

create policy "signed-in members and officers read dues rules" on public.dues_rules for select to authenticated
  using ((select app.current_member_id()) is not null or (select app.is_officer()));

create policy "officers read levies" on public.levies for select to authenticated
  using ((select app.is_officer()));

create policy "officers read levy targets" on public.levy_targets for select to authenticated
  using ((select app.is_officer()));

create policy "member reads own charges; officers read all" on public.charges for select to authenticated
  using (member_id = (select app.current_member_id()) or (select app.is_officer()));

create policy "member reads own adjustments; officers read all" on public.adjustments for select to authenticated
  using ((select app.is_officer())
         or exists (select 1 from public.charges c where c.id = charge_id and c.member_id = (select app.current_member_id())));

create policy "member reads own attempts; officers read all" on public.payment_attempts for select to authenticated
  using (member_id = (select app.current_member_id()) or (select app.is_officer()));

create policy "member reads own attempt lines; officers read all" on public.payment_attempt_charges for select to authenticated
  using ((select app.is_officer())
         or exists (select 1 from public.payment_attempts pa where pa.id = attempt_id and pa.member_id = (select app.current_member_id())));

create policy "member reads own payments; officers read all" on public.payments for select to authenticated
  using (member_id = (select app.current_member_id()) or (select app.is_officer()));

create policy "member reads own allocations; officers read all" on public.allocations for select to authenticated
  using ((select app.is_officer())
         or exists (select 1 from public.payments p where p.id = payment_id and p.member_id = (select app.current_member_id())));

create policy "member reads own receipts; officers read all" on public.receipts for select to authenticated
  using (member_id = (select app.current_member_id()) or (select app.is_officer()));

create policy "officers read the outbox" on public.outbox_messages for select to authenticated
  using ((select app.is_officer()));

create policy "officers read tasks" on public.tasks for select to authenticated
  using ((select app.is_officer()));

create policy "officers read job runs" on public.job_runs for select to authenticated
  using ((select app.is_officer()));

create policy "officers read the audit trail" on public.audit_events for select to authenticated
  using ((select app.is_officer()));

-- app.settings, app.provider_events and app.analytics_outbox have RLS enabled
-- and no policies: no API role can read or write them directly.

-- ---------------------------------------------------------------- 3. callable functions

-- Members
grant execute on function public.start_payment_attempt(uuid[]), public.abandon_payment_attempt(uuid),
                         public.report_discrepancy(text)
  to authenticated;

-- Officers (each function also checks officer status itself)
grant execute on function public.run_recurring_assessment(), public.publish_levy(text, bigint, date, date, uuid[]),
                         public.add_adjustment(uuid, bigint, text), public.run_reminder_job(), public.deliver_reminder_previews(),
                         public.review_task(uuid, text), public.collection_report(), public.record_opening_payment(uuid, uuid, bigint, text)
  to authenticated;

-- Server code only (service_role key, never shipped to browsers)
grant execute on function public.server_record_checkout_session(text, text), public.server_close_unopened_attempt(text, text),
                         public.server_record_provider_status(text, text),
                         public.server_post_verified_payment(text, text, text, bigint, text, timestamptz, text, text),
                         public.server_record_provider_event(text, text, text, text, jsonb),
                         public.server_claim_provider_events(integer, integer), public.server_finish_provider_event(uuid, text, text),
                         public.server_attempts_to_reconcile(integer, integer),
                         public.server_claim_analytics_events(integer, integer), public.server_finish_analytics_event(uuid, boolean, text),
                         public.server_link_member_user(uuid, uuid), public.server_grant_officer(uuid, text), public.server_set_test_clock(timestamptz),
                         public.run_recurring_assessment(), public.run_reminder_job(), public.deliver_reminder_previews(), public.collection_report()
  to service_role;
grant usage on schema public to service_role;
