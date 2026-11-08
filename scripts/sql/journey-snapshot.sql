-- Read-only snapshot for the Paystack test-payment journey (checks 4-10).
-- Run through the Management API's read-only SQL route, before and after the
-- payment. Uses base tables only (the read-only role cannot run the balance
-- helpers). Prints no keys, emails or payloads.
with a as (select '00000000-0000-4000-8000-00000000000a'::uuid id),
ch as (
  select c.id, c.title, c.amount_kobo, c.due_date,
    coalesce((select sum(x.amount_kobo) from public.allocations x where x.charge_id = c.id), 0) alloc,
    coalesce((select sum(x.amount_kobo) from public.adjustments x where x.charge_id = c.id), 0) adj
  from public.charges c, a where c.member_id = a.id)
select json_build_object(
  'clock', (select clock_override from app.settings),
  'member_a_charges', (select json_agg(json_build_object('title', title, 'amount', amount_kobo / 100, 'due', due_date,
      'paid', alloc / 100, 'outstanding', (amount_kobo + adj - alloc) / 100) order by due_date) from ch),
  'member_a_outstanding', (select sum(amount_kobo + adj - alloc) / 100 from ch),
  'member_a_overdue', (select coalesce(sum(amount_kobo + adj - alloc), 0) / 100 from ch, app.settings s where due_date < (s.clock_override at time zone 'Africa/Lagos')::date),
  'member_a_outbox', (select json_agg(json_build_object('kind', o.kind, 'status', o.status, 'reason', o.status_reason,
      'charge', (select title from public.charges c where c.id = o.charge_id)) order by o.created_at) from public.outbox_messages o, a where o.member_id = a.id),
  'member_a_attempts', (select json_agg(json_build_object('reference', reference, 'provider', provider, 'status', status, 'amount', amount_kobo / 100) order by created_at) from public.payment_attempts p, a where p.member_id = a.id),
  'member_a_receipts', (select json_agg(json_build_object('number', number, 'amount', amount_kobo / 100) order by issued_at) from public.receipts r, a where r.member_id = a.id),
  'member_c_attempt', (select json_agg(json_build_object('reference', reference, 'status', status, 'checks', verification_checks, 'last_provider_status', last_provider_status)) from public.payment_attempts where member_id = '00000000-0000-4000-8000-00000000000c'),
  'provider_events', (select json_agg(json_build_object('type', event_type, 'status', status, 'attempts', attempts)) from app.provider_events),
  'analytics_outbox', (select json_agg(json_build_object('event', event, 'status', status)) from app.analytics_outbox),
  'totals', json_build_object('payments', (select count(*) from public.payments), 'receipts', (select count(*) from public.receipts),
      'allocations', (select count(*) from public.allocations), 'attempts', (select count(*) from public.payment_attempts),
      'open_tasks', (select count(*) from public.tasks where status = 'open'), 'outbox', (select count(*) from public.outbox_messages)),
  'latest_worker', (select json_build_object('at', created, 'http', status_code, 'reconciled', content::jsonb -> 'reconciled' ->> 'checked',
      'analytics', content::jsonb -> 'analytics' ->> 'status') from net._http_response order by id desc limit 1),
  'cron', (select json_agg(json_build_object('job', jobname, 'schedule', schedule, 'active', active)) from cron.job)
) as snapshot;
