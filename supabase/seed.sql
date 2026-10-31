-- Community Ledger · fictional seed data (test environment only)
--
-- Every name and amount is fictional. The history is replayed through the same
-- database functions the app uses, at earlier test-clock times, so the starting
-- state is exactly what the automation would have produced. It matches the
-- milestone 1 demo fixtures. Runs as the database owner (a trusted session).
-- Sign-in accounts are not created here: see scripts/create-test-users.mjs.

insert into public.organisations (id, name) values ('00000000-0000-4000-8000-000000000001', 'Placeholder community group (fictional)');
insert into app.settings (group_id, environment, clock_override) values ('00000000-0000-4000-8000-000000000001', 'test', null);

insert into public.members (id, group_id, display_name, status, joined_on, reminder_channel, analytics_id) values
  ('00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000001', 'Member A', 'active', '2025-03-01', 'whatsapp', 'an_7f3a91c2d84e51be'),
  ('00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-000000000001', 'Member B', 'active', '2024-06-01', 'whatsapp', 'an_c2d84e51be079a60'),
  ('00000000-0000-4000-8000-00000000000c', '00000000-0000-4000-8000-000000000001', 'Member C', 'active', '2025-09-01', 'email',    'an_51be079a60f27f3a'),
  ('00000000-0000-4000-8000-00000000000d', '00000000-0000-4000-8000-000000000001', 'Member D', 'active', '2026-11-15', 'whatsapp', 'an_9a60f27f3a91c2d8');

insert into public.dues_rules (group_id, code, name, amount_kobo, frequency, issue_day, due_day, first_period) values
  ('00000000-0000-4000-8000-000000000001', 'annual-dues', 'Annual dues', 2000000, 'annual', '11-01', '11-20', '2026'),
  -- Not yet assessed at the starting clock: demonstrates the recurring job.
  ('00000000-0000-4000-8000-000000000001', 'monthly-meeting', 'Monthly meeting contribution', 200000, 'monthly', '01', '28', '2026-12');

do $seed$
declare
  a uuid := '00000000-0000-4000-8000-00000000000a';
  b uuid := '00000000-0000-4000-8000-00000000000b';
  c uuid := '00000000-0000-4000-8000-00000000000c';
  abc uuid[] := array['00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000c']::uuid[];
  v_attempt public.payment_attempts;
  charge_of text := 'select id from public.charges where member_id = $1 and title like $2';
  v_id uuid;
begin
  -- 1 November: dues assessed, two levies published, notices previewed.
  update app.settings set clock_override = '2026-11-01 09:00 Africa/Lagos';
  perform public.run_recurring_assessment();
  perform public.publish_levy('Community project levy', 1000000, '2026-11-01', '2026-11-30', abc);
  perform public.publish_levy('Welfare contribution', 500000, '2026-11-01', '2026-12-10', abc);
  update app.settings set clock_override = '2026-11-01 09:05 Africa/Lagos';
  perform public.deliver_reminder_previews();

  -- 5 November: an approved opening record of a ₦5,000 part payment by Member A.
  update app.settings set clock_override = '2026-11-05 11:00 Africa/Lagos';
  execute charge_of into v_id using a, 'Annual dues%';
  perform public.record_opening_payment(a, v_id, 500000, 'Opening balance (fictional)');

  -- 8 November: Member B pays everything through the provider (fictional test transaction).
  update app.settings set clock_override = '2026-11-08 18:30 Africa/Lagos';
  v_attempt := app.create_attempt(b, array(select id from public.charges where member_id = b order by due_date));
  perform app.post_payment(v_attempt.provider, 'SEED-TX-1001', v_attempt.reference, v_attempt.amount_kobo, 'NGN',
                           '2026-11-08 18:30 Africa/Lagos', 'seed-1001', 'test', 'provider');

  -- 19 November: Member C submits a payment for annual dues that never resolves.
  update app.settings set clock_override = '2026-11-19 15:00 Africa/Lagos';
  execute charge_of into v_id using c, 'Annual dues%';
  v_attempt := app.create_attempt(c, array[v_id]);
  update public.payment_attempts set status = 'pending', checkout_opened_at = app.now(), last_provider_status = 'pending' where id = v_attempt.id;
  update app.settings set clock_override = '2026-11-20 09:00 Africa/Lagos';
  perform public.server_record_provider_status(v_attempt.reference, 'pending');
  update app.settings set clock_override = '2026-11-21 09:00 Africa/Lagos';
  perform public.run_reminder_job();
  update app.settings set clock_override = '2026-11-23 09:00 Africa/Lagos';
  perform public.server_record_provider_status(v_attempt.reference, 'pending');
  perform public.run_reminder_job();

  -- Starting test clock: Tuesday 24 November 2026, 10:00 Lagos.
  update app.settings set clock_override = '2026-11-24 10:00 Africa/Lagos';

  -- Seeded history is not product usage: drop analytics rows it produced.
  delete from app.analytics_outbox;
end
$seed$;
