-- Community Ledger · balances, jobs and payment posting
--
-- Conventions
--   * Functions that change records are SECURITY DEFINER with an empty
--     search_path and check who is calling. They are the only write path:
--     the API roles have no INSERT/UPDATE/DELETE grants on any table.
--   * Read helpers are SECURITY INVOKER so row-level security still applies
--     when a member's request uses them.
--   * Business time comes from app.now(), which honours the test clock.

-- ---------------------------------------------------------------- context

create function app.now() returns timestamptz
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.clock_override from app.settings s where s.environment = 'test'), now())
$$;

create function app.group_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select s.group_id from app.settings s
$$;

create function app.due_soon_fraction() returns numeric
language sql stable security definer set search_path = '' as $$
  select s.due_soon_fraction from app.settings s
$$;

create function app.pending_pause() returns interval
language sql stable security definer set search_path = '' as $$
  select s.pending_pause from app.settings s
$$;

-- The role claimed by the request's JWT ('' for a direct database session).
create function app.request_role() returns text
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
$$;

-- Server code (service_role key) or a direct administrative database session.
create function app.is_trusted() returns boolean
language sql stable set search_path = '' as $$
  select app.request_role() = 'service_role'
      or (app.request_role() = '' and session_user <> 'authenticator')
$$;

create function app.current_member_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select m.id from public.members m where m.user_id = auth.uid() and auth.uid() is not null
$$;

-- Officer status comes only from public.officers, never from JWT or user metadata.
create function app.is_officer() returns boolean
language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists (select 1 from public.officers o where o.user_id = auth.uid())
$$;

create function app.require_officer() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not (app.is_officer() or app.is_trusted()) then
    raise exception 'Only officers can do this.' using errcode = '42501';
  end if;
end $$;

create function app.require_trusted() returns void
language plpgsql stable set search_path = '' as $$
begin
  if not app.is_trusted() then
    raise exception 'Server operation only.' using errcode = '42501';
  end if;
end $$;

create function app.actor() returns text
language sql stable set search_path = '' as $$
  select case when app.request_role() = 'service_role' then 'system'
              when app.is_officer() then 'officer'
              when app.current_member_id() is not null then 'member'
              else 'system' end
$$;

create function app.audit(p_action text, p_detail text, p_actor text default null) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_events (at, actor, actor_user, action, detail)
  values (app.now(), coalesce(p_actor, app.actor()), auth.uid(), p_action, p_detail)
$$;

-- ---------------------------------------------------------------- formatting & dates

create function app.naira(p_kobo bigint) returns text
language sql immutable set search_path = '' as $$
  select '₦' || to_char(p_kobo / 100, 'FM999,999,999,990')
      || case when p_kobo % 100 <> 0 then '.' || lpad((p_kobo % 100)::text, 2, '0') else '' end
$$;

create function app.day_label(p_date date) returns text
language sql immutable set search_path = '' as $$
  select to_char(p_date, 'FMDD FMMonth')
$$;

create function app.lagos_date(p_at timestamptz) returns date
language sql immutable set search_path = '' as $$
  select (p_at at time zone 'Africa/Lagos')::date
$$;

create function app.day_start(p_date date) returns timestamptz
language sql immutable set search_path = '' as $$
  select (p_date::timestamp at time zone 'Africa/Lagos')
$$;

-- Demo rule: a charge is payable until the end of its due date in Lagos.
create function app.due_cutoff(p_due date) returns timestamptz
language sql immutable set search_path = '' as $$
  select ((p_due + 1)::timestamp at time zone 'Africa/Lagos')
$$;

-- ---------------------------------------------------------------- balances (invoker: RLS applies)

create function app.charge_allocated(p_charge_id uuid) returns bigint
language sql stable set search_path = '' as $$
  select coalesce(sum(a.amount_kobo), 0)::bigint from public.allocations a where a.charge_id = p_charge_id
$$;

create function app.charge_adjusted(p_charge_id uuid) returns bigint
language sql stable set search_path = '' as $$
  select coalesce(sum(a.amount_kobo), 0)::bigint from public.adjustments a where a.charge_id = p_charge_id
$$;

create function app.charge_outstanding(p_charge_id uuid) returns bigint
language sql stable set search_path = '' as $$
  select c.amount_kobo + app.charge_adjusted(c.id) - app.charge_allocated(c.id)
  from public.charges c where c.id = p_charge_id
$$;

create function app.charge_status(p_charge_id uuid, p_at timestamptz) returns text
language sql stable set search_path = '' as $$
  select case
    when app.charge_outstanding(c.id) = 0 then 'paid'
    when p_at >= app.due_cutoff(c.due_date) then 'overdue'
    when extract(epoch from p_at - app.day_start(c.issue_date))
         / extract(epoch from app.due_cutoff(c.due_date) - app.day_start(c.issue_date)) >= app.due_soon_fraction() then 'due-soon'
    else 'outstanding' end
  from public.charges c where c.id = p_charge_id
$$;

create function app.payment_unapplied(p_payment_id uuid) returns bigint
language sql stable set search_path = '' as $$
  select p.amount_kobo - coalesce((select sum(a.amount_kobo) from public.allocations a where a.payment_id = p.id), 0)
  from public.payments p where p.id = p_payment_id
$$;

-- True when every charge a pending attempt covers has since been paid another way.
create function app.attempt_settled(p_attempt_id uuid) returns boolean
language sql stable set search_path = '' as $$
  select coalesce(bool_and(app.charge_outstanding(pac.charge_id) = 0), true)
  from public.payment_attempt_charges pac where pac.attempt_id = p_attempt_id
$$;

-- Guard: corrections and allocations can never push a charge below zero.
create function app.check_charge_not_negative() returns trigger
language plpgsql set search_path = '' as $$
begin
  if app.charge_outstanding(new.charge_id) < 0 then
    raise exception 'This would make the charge balance negative.' using errcode = '23514';
  end if;
  return new;
end $$;

create constraint trigger allocations_not_over_charge after insert on public.allocations
  deferrable initially immediate for each row execute function app.check_charge_not_negative();
create constraint trigger adjustments_not_over_charge after insert on public.adjustments
  deferrable initially immediate for each row execute function app.check_charge_not_negative();

-- Financial history is append-only.
create function app.forbid_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% records cannot be changed or deleted. Add a correction instead.', tg_table_name using errcode = '42501';
end $$;

create trigger payments_append_only before update or delete on public.payments for each row execute function app.forbid_change();
create trigger allocations_append_only before update or delete on public.allocations for each row execute function app.forbid_change();
create trigger receipts_append_only before update or delete on public.receipts for each row execute function app.forbid_change();
create trigger adjustments_append_only before update or delete on public.adjustments for each row execute function app.forbid_change();
create trigger audit_append_only before update or delete on public.audit_events for each row execute function app.forbid_change();
create trigger charges_no_delete before delete on public.charges for each row execute function app.forbid_change();

-- ---------------------------------------------------------------- read views (invoker: RLS applies)

create view public.charge_balances with (security_invoker = true) as
select c.id, c.member_id, c.title, c.amount_kobo, c.issue_date, c.due_date, c.source_type, c.created_at,
       app.charge_allocated(c.id) as paid_kobo,
       app.charge_adjusted(c.id) as adjustment_kobo,
       app.charge_outstanding(c.id) as outstanding_kobo,
       app.charge_status(c.id, app.now()) as status,
       exists (select 1 from public.payment_attempt_charges pac
               join public.payment_attempts pa on pa.id = pac.attempt_id
               where pac.charge_id = c.id and pa.status = 'pending') as has_pending_attempt
from public.charges c;

create view public.member_balances with (security_invoker = true) as
select m.id as member_id, m.display_name,
       coalesce(sum(cb.amount_kobo + cb.adjustment_kobo), 0)::bigint as assessed_kobo,
       coalesce(sum(cb.paid_kobo), 0)::bigint as paid_kobo,
       coalesce(sum(cb.outstanding_kobo), 0)::bigint as outstanding_kobo,
       coalesce(sum(cb.outstanding_kobo) filter (where cb.status = 'overdue'), 0)::bigint as overdue_kobo,
       coalesce(sum(cb.outstanding_kobo) filter (where cb.status <> 'overdue'), 0)::bigint as upcoming_kobo,
       (select coalesce(sum(app.payment_unapplied(p.id)), 0) from public.payments p where p.member_id = m.id)::bigint as credit_kobo,
       min(cb.due_date) filter (where cb.outstanding_kobo > 0 and cb.status <> 'overdue') as next_due_date
from public.members m
left join public.charge_balances cb on cb.member_id = m.id
group by m.id, m.display_name;

-- A member's payment attempts with whether their dues were since paid another way.
create view public.payment_attempt_overview with (security_invoker = true) as
select pa.id, pa.member_id, pa.reference, pa.amount_kobo, pa.currency, pa.status, pa.closed_reason,
       pa.created_at, pa.updated_at, pa.checkout_opened_at,
       (pa.status = 'pending' and app.attempt_settled(pa.id)) as charges_paid_elsewhere
from public.payment_attempts pa;

-- ---------------------------------------------------------------- reminders and notices

create function app.reminder_key(p_charge_id uuid, p_due date, p_kind public.outbox_kind, p_at timestamptz) returns text
language sql stable set search_path = '' as $$
  select case when p_kind = 'reminder-overdue'
    then p_charge_id::text || ':overdue:week-' || floor(extract(epoch from p_at - app.due_cutoff(p_due)) / 604800)::int
    else p_charge_id::text || ':' || p_kind::text end
$$;

create function app.message_body(p_charge_id uuid, p_kind public.outbox_kind) returns text
language sql stable set search_path = '' as $$
  select case p_kind
    when 'new-charge' then format('Hello %s, %s of %s has been added to your dues. It is due on %s.',
      m.display_name, c.title, app.naira(app.charge_outstanding(c.id)), app.day_label(c.due_date))
    when 'reminder-due-soon' then format('Hello %s, a reminder that %s (%s) is due on %s.',
      m.display_name, c.title, app.naira(app.charge_outstanding(c.id)), app.day_label(c.due_date))
    else format('Hello %s, %s (%s) was due on %s and is still open. You can pay it in Community Ledger.',
      m.display_name, c.title, app.naira(app.charge_outstanding(c.id)), app.day_label(c.due_date))
  end
  from public.charges c join public.members m on m.id = c.member_id where c.id = p_charge_id
$$;

-- The reminder that fits a charge right now, if any.
create function app.current_reminder(p_charge_id uuid, out kind public.outbox_kind, out key text)
language plpgsql stable set search_path = '' as $$
declare
  v_status text := app.charge_status(p_charge_id, app.now());
  v_due date;
begin
  if v_status not in ('due-soon', 'overdue') then return; end if;
  select c.due_date into v_due from public.charges c where c.id = p_charge_id;
  kind := case when v_status = 'overdue' then 'reminder-overdue'::public.outbox_kind else 'reminder-due-soon'::public.outbox_kind end;
  key := app.reminder_key(p_charge_id, v_due, kind, app.now());
end $$;

create function app.queue_notification(p_charge_id uuid, p_kind public.outbox_kind) returns uuid
language plpgsql set search_path = '' as $$
declare
  v_member public.members;
  v_due date;
  v_id uuid;
begin
  select m.* into v_member from public.members m join public.charges c on c.member_id = m.id where c.id = p_charge_id;
  if v_member.reminder_channel = 'none' then return null; end if;
  select c.due_date into v_due from public.charges c where c.id = p_charge_id;
  insert into public.outbox_messages (key, member_id, charge_id, kind, channel, body, created_at, updated_at)
  values (app.reminder_key(p_charge_id, v_due, p_kind, app.now()), v_member.id, p_charge_id, p_kind,
          v_member.reminder_channel, app.message_body(p_charge_id, p_kind), app.now(), app.now())
  on conflict (key) do nothing
  returning id into v_id;
  return v_id;
end $$;

-- Why an unsent message should no longer go out now, or null if it still should.
create function app.stale_reason(p_msg public.outbox_messages) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_current record;
begin
  if p_msg.kind = 'new-charge' then
    return case when app.charge_status(p_msg.charge_id, app.now()) = 'overdue'
                then 'Superseded: the charge is now overdue' end;
  end if;
  select * into v_current from app.current_reminder(p_msg.charge_id);
  if v_current.kind is null then return 'Superseded: no reminder is due for this charge now'; end if;
  if v_current.key = p_msg.key then return null; end if;
  if v_current.kind <> p_msg.kind then
    return case when v_current.kind = 'reminder-overdue' then 'Superseded: the charge is now overdue' else 'Superseded: stage changed' end;
  end if;
  return 'Superseded by a newer weekly reminder';
end $$;

-- Cancels a charge's unsent messages that no longer fit its stage. Rows are kept.
create function app.supersede_stale(p_charge_id uuid) returns integer
language plpgsql set search_path = '' as $$
declare
  v_msg public.outbox_messages;
  v_reason text;
  v_current record;
  v_n integer := 0;
begin
  select * into v_current from app.current_reminder(p_charge_id);
  for v_msg in select * from public.outbox_messages o where o.charge_id = p_charge_id and o.status = 'scheduled' for update loop
    v_reason := app.stale_reason(v_msg);
    continue when v_reason is null;
    update public.outbox_messages
       set status = 'cancelled', status_reason = v_reason, updated_at = app.now(),
           superseded_by = case when v_current.key is distinct from v_msg.key then v_current.key end
     where id = v_msg.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- A submitted (pending) payment inside the bounded pause window. Opened or
-- abandoned checkouts never pause reminders.
create function app.pausing_attempt(p_charge_id uuid) returns public.payment_attempts
language sql stable set search_path = '' as $$
  select pa.* from public.payment_attempts pa
  join public.payment_attempt_charges pac on pac.attempt_id = pa.id
  where pac.charge_id = p_charge_id and pa.status = 'pending'
    and app.now() - pa.created_at < app.pending_pause()
  order by pa.created_at limit 1
$$;

create function app.flag_unresolved_attempts() returns integer
language plpgsql set search_path = '' as $$
declare
  v_a public.payment_attempts;
  v_n integer := 0;
  v_id uuid;
begin
  for v_a in select * from public.payment_attempts pa
             where pa.status = 'pending' and app.now() - pa.created_at >= app.pending_pause() loop
    insert into public.tasks (key, type, member_id, ref_id, title, detail, created_at)
    values ('unresolved:' || v_a.id, 'unresolved-payment', v_a.member_id, v_a.id::text, 'Payment still unconfirmed',
            format('Attempt %s for %s has not been confirmed after %s. Nothing was credited from it. ',
                   v_a.reference, app.naira(v_a.amount_kobo), app.pending_pause())
            || case when app.attempt_settled(v_a.id)
                    then 'The dues it covered have since been paid by another payment. If this one is confirmed later it will be kept as credit for review.'
                    else 'Reminders have resumed.' end,
            app.now())
    on conflict (key) do nothing
    returning id into v_id;
    if v_id is not null then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end $$;

create function app.cancel_reminders_for_paid(p_charge_ids uuid[], p_reason text) returns integer
language plpgsql set search_path = '' as $$
declare v_n integer;
begin
  update public.outbox_messages o
     set status = 'cancelled', status_reason = p_reason, updated_at = app.now()
   where o.status = 'scheduled' and o.charge_id = any (p_charge_ids) and app.charge_outstanding(o.charge_id) = 0;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create function public.run_reminder_job() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_charge public.charges;
  v_member public.members;
  v_current record;
  v_details jsonb := '[]'::jsonb;
  v_queued integer := 0; v_dupes integer := 0; v_paused integer := 0; v_superseded integer := 0; v_flagged integer;
  v_n integer;
  v_pause public.payment_attempts;
  v_summary text;
begin
  perform app.require_officer();
  v_flagged := app.flag_unresolved_attempts();
  if v_flagged > 0 then v_details := v_details || to_jsonb(format('%s unconfirmed payment(s) sent to Needs attention', v_flagged)); end if;

  for v_charge in select c.* from public.charges c join public.members m on m.id = c.member_id
                  where c.issue_date <= app.lagos_date(app.now()) order by m.display_name, c.due_date, c.id loop
    select * into v_member from public.members where id = v_charge.member_id;
    v_n := app.supersede_stale(v_charge.id);
    if v_n > 0 then
      v_superseded := v_superseded + v_n;
      v_details := v_details || to_jsonb(format('%s · %s: %s older unsent message(s) superseded', v_member.display_name, v_charge.title, v_n));
    end if;
    select * into v_current from app.current_reminder(v_charge.id);
    continue when v_current.kind is null;
    if v_member.reminder_channel = 'none' then
      v_details := v_details || to_jsonb(format('%s · %s: skipped, reminders turned off', v_member.display_name, v_charge.title));
      continue;
    end if;
    if exists (select 1 from public.outbox_messages o where o.key = v_current.key) then
      v_dupes := v_dupes + 1; continue;
    end if;
    v_pause := app.pausing_attempt(v_charge.id);
    if v_pause.id is not null then
      v_paused := v_paused + 1;
      v_details := v_details || to_jsonb(format('%s · %s: paused while payment %s is checked', v_member.display_name, v_charge.title, v_pause.reference));
      continue;
    end if;
    if app.queue_notification(v_charge.id, v_current.kind) is not null then
      v_queued := v_queued + 1;
      v_details := v_details || to_jsonb(format('%s · %s: %s preview queued', v_member.display_name, v_charge.title,
                                                 case when v_current.kind = 'reminder-overdue' then 'overdue' else 'due soon' end));
    end if;
  end loop;

  v_summary := format('%s new preview(s), %s already queued, %s paused', v_queued, v_dupes, v_paused)
            || case when v_superseded > 0 then format(', %s superseded', v_superseded) else '' end;
  insert into public.job_runs (type, ran_at, summary, details, run_by) values ('reminders', app.now(), v_summary, v_details, auth.uid());
  perform app.audit('Reminder job', v_summary);
  return jsonb_build_object('queued', v_queued, 'already_queued', v_dupes, 'paused', v_paused, 'superseded', v_superseded, 'flagged', v_flagged, 'summary', v_summary);
end $$;

-- Simulated delivery. Rechecks each scheduled message immediately before
-- "delivery" and rebuilds its wording. Nothing is sent in milestone 2.
create function public.deliver_reminder_previews() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_msg public.outbox_messages;
  v_member public.members;
  v_reason text;
  v_current record;
  v_previewed integer := 0; v_cancelled integer := 0;
  v_summary text;
begin
  perform app.require_officer();
  for v_msg in select * from public.outbox_messages o where o.status = 'scheduled' order by o.created_at, o.id for update loop
    select * into v_member from public.members where id = v_msg.member_id;
    if app.charge_outstanding(v_msg.charge_id) = 0 then v_reason := 'Already paid';
    elsif v_member.reminder_channel = 'none' then v_reason := 'Member turned reminders off';
    else v_reason := app.stale_reason(v_msg);
    end if;
    if v_reason is null and v_msg.kind <> 'new-charge' and (app.pausing_attempt(v_msg.charge_id)).id is not null then
      continue; -- stays scheduled until the pause window ends
    end if;
    if v_reason is not null then
      select * into v_current from app.current_reminder(v_msg.charge_id);
      update public.outbox_messages
         set status = 'cancelled', status_reason = v_reason, updated_at = app.now(),
             superseded_by = case when v_reason like 'Superseded%' and v_current.key is distinct from v_msg.key then v_current.key end
       where id = v_msg.id;
      v_cancelled := v_cancelled + 1;
    else
      update public.outbox_messages
         set status = 'previewed', body = app.message_body(v_msg.charge_id, v_msg.kind),
             status_reason = 'Preview only. Not sent: no messaging service is connected.', updated_at = app.now()
       where id = v_msg.id;
      v_previewed := v_previewed + 1;
    end if;
  end loop;
  v_summary := format('%s preview(s) ready (not sent), %s cancelled on recheck', v_previewed, v_cancelled);
  insert into public.job_runs (type, ran_at, summary, run_by) values ('reminder-delivery', app.now(), v_summary, auth.uid());
  perform app.audit('Simulated message delivery', v_summary);
  return jsonb_build_object('previewed', v_previewed, 'cancelled', v_cancelled, 'summary', v_summary);
end $$;

-- ---------------------------------------------------------------- assessment

create function app.add_charge_once(p_key text, p_member_id uuid, p_source_type text, p_rule_id uuid, p_period text,
                                    p_levy_id uuid, p_title text, p_amount bigint, p_issue date, p_due date) returns uuid
language plpgsql set search_path = '' as $$
declare v_id uuid;
begin
  insert into public.charges (group_id, key, member_id, source_type, rule_id, period, levy_id, title, amount_kobo, issue_date, due_date, created_at)
  values (app.group_id(), p_key, p_member_id, p_source_type, p_rule_id, p_period, p_levy_id, p_title, p_amount, p_issue, p_due, app.now())
  on conflict (key) do nothing
  returning id into v_id;
  return v_id;
end $$;

-- Recurring dues job: assesses the open period, plus the next one if it opens
-- within assess_ahead_days, once per eligible member.
create function public.run_recurring_assessment() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_today date := app.lagos_date(app.now());
  v_horizon date := v_today + (select s.assess_ahead_days from app.settings s);
  v_rule public.dues_rules;
  v_periods text[];
  v_period text;
  v_issue date; v_due date;
  v_member public.members;
  v_made integer; v_skipped integer;
  v_created integer := 0; v_already integer := 0;
  v_ineligible text[];
  v_label text;
  v_details jsonb := '[]'::jsonb;
  v_summary text;
begin
  perform app.require_officer();
  for v_rule in select * from public.dues_rules order by code loop
    if v_rule.frequency = 'annual' then
      v_periods := array[extract(year from v_today)::int::text, (extract(year from v_today)::int + 1)::text];
    else
      v_periods := array[to_char(v_today, 'YYYY-MM'), to_char(date_trunc('month', v_today) + interval '1 month', 'YYYY-MM')];
    end if;
    foreach v_period in array v_periods loop
      continue when v_period < v_rule.first_period;
      begin
        v_issue := (v_period || '-' || v_rule.issue_day)::date;
        v_due := (v_period || '-' || v_rule.due_day)::date;
      exception when others then
        v_issue := null;
      end;
      if v_issue is null or v_due < v_issue then
        insert into public.tasks (key, type, ref_id, title, detail, created_at)
        values ('invalid-rule:' || v_rule.code || ':' || v_period, 'invalid-rule', v_rule.id::text,
                v_rule.name || ': dates need checking', 'Period ' || v_period || ' has invalid dates. No charges were created.', app.now())
        on conflict (key) do nothing;
        v_details := v_details || to_jsonb(v_rule.name || ' ' || v_period || ': skipped, invalid dates sent to Needs attention');
        continue;
      end if;
      continue when v_issue > v_horizon;
      v_label := case when v_rule.frequency = 'annual' then v_period else to_char(v_issue, 'FMMonth YYYY') end;
      v_made := 0; v_skipped := 0; v_ineligible := '{}';
      for v_member in select * from public.members order by display_name loop
        if v_member.status <> 'active' or v_member.joined_on > v_issue then
          v_ineligible := v_ineligible || v_member.display_name;
          continue;
        end if;
        if app.add_charge_once('rule:' || v_rule.code || ':' || v_period || ':' || v_member.id, v_member.id, 'rule', v_rule.id,
                               v_period, null, v_rule.name || ' ' || v_label, v_rule.amount_kobo, v_issue, v_due) is not null then
          v_made := v_made + 1;
        else
          v_skipped := v_skipped + 1;
        end if;
      end loop;
      v_created := v_created + v_made;
      v_already := v_already + v_skipped;
      v_details := v_details || to_jsonb(format('%s %s: %s new, %s already assessed', v_rule.name, v_label, v_made, v_skipped)
                   || case when cardinality(v_ineligible) > 0 then ', not eligible: ' || array_to_string(v_ineligible, ', ') else '' end);
    end loop;
  end loop;
  v_summary := format('%s new charge(s), %s already assessed', v_created, v_already);
  insert into public.job_runs (type, ran_at, summary, details, run_by) values ('assessment', app.now(), v_summary, v_details, auth.uid());
  perform app.audit('Recurring dues job', v_summary);
  return jsonb_build_object('created', v_created, 'already_assessed', v_already, 'summary', v_summary);
end $$;

-- Creates and publishes a levy: one charge per selected member, plus one notice preview each.
create function public.publish_levy(p_name text, p_amount_kobo bigint, p_issue_date date, p_due_date date, p_member_ids uuid[]) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_levy uuid;
  v_member uuid;
  v_charge uuid;
  v_n integer := 0;
begin
  perform app.require_officer();
  if coalesce(trim(p_name), '') = '' then raise exception 'Give the levy a name.' using errcode = '22023'; end if;
  if p_amount_kobo is null or p_amount_kobo <= 0 then raise exception 'Enter an amount above ₦0.' using errcode = '22023'; end if;
  if p_due_date < p_issue_date then raise exception 'The due date must be on or after the start date.' using errcode = '22023'; end if;
  if coalesce(cardinality(p_member_ids), 0) = 0 then raise exception 'Choose at least one member.' using errcode = '22023'; end if;
  if exists (select 1 from unnest(p_member_ids) x(id) where not exists (select 1 from public.members m where m.id = x.id)) then
    raise exception 'Some selected members no longer exist.' using errcode = '22023';
  end if;
  insert into public.levies (group_id, name, amount_kobo, issue_date, due_date, status, published_at, created_by)
  values (app.group_id(), trim(p_name), p_amount_kobo, p_issue_date, p_due_date, 'published', app.now(), auth.uid())
  returning id into v_levy;
  for v_member in select distinct x.id from unnest(p_member_ids) x(id) loop
    insert into public.levy_targets (levy_id, member_id) values (v_levy, v_member);
    v_charge := app.add_charge_once('levy:' || v_levy || ':' || v_member, v_member, 'levy', null, null, v_levy,
                                    trim(p_name), p_amount_kobo, p_issue_date, p_due_date);
    if v_charge is not null then
      perform app.queue_notification(v_charge, 'new-charge');
      v_n := v_n + 1;
    end if;
  end loop;
  insert into public.job_runs (type, ran_at, summary, run_by)
  values ('levy-publish', app.now(), format('%s: %s new charge(s) of %s', trim(p_name), v_n, app.naira(p_amount_kobo)), auth.uid());
  perform app.audit('Levy published', format('%s: %s charge(s) of %s', trim(p_name), v_n, app.naira(p_amount_kobo)));
  return v_levy;
end $$;

-- An explicit correction or waiver. Never edits history; adds a signed row.
create function public.add_adjustment(p_charge_id uuid, p_amount_kobo bigint, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.require_officer();
  perform 1 from public.charges where id = p_charge_id for update;
  if not found then raise exception 'Unknown charge.' using errcode = '22023'; end if;
  insert into public.adjustments (group_id, charge_id, amount_kobo, reason, created_by, created_at)
  values (app.group_id(), p_charge_id, p_amount_kobo, trim(p_reason), auth.uid(), app.now())
  returning id into v_id;
  perform app.cancel_reminders_for_paid(array[p_charge_id], 'Cleared by an adjustment');
  perform app.audit('Adjustment', format('%s on charge %s: %s', app.naira(p_amount_kobo), p_charge_id, trim(p_reason)));
  return v_id;
end $$;

-- ---------------------------------------------------------------- analytics outbox

-- Only allowlisted, non-identifying properties. No names, contact details,
-- amounts, references, free text or URLs.
create function app.queue_analytics(p_event text, p_event_key text, p_member_id uuid) returns void
language sql set search_path = '' as $$
  insert into app.analytics_outbox (event_key, event, distinct_id, properties, occurred_at)
  select p_event_key, p_event, m.analytics_id,
         jsonb_build_object('schema_version', 1, 'environment', 'test', 'is_demo', false,
                            'surface', 'server', '$process_person_profile', false),
         now()
  from public.members m where m.id = p_member_id
  on conflict (event_key) do nothing
$$;

-- ---------------------------------------------------------------- payment attempts

create function app.create_attempt(p_member_id uuid, p_charge_ids uuid[]) returns public.payment_attempts
language plpgsql set search_path = '' as $$
declare
  v_attempt public.payment_attempts;
  v_total bigint := 0;
  v_charge public.charges;
  v_owed bigint;
begin
  if coalesce(cardinality(p_charge_ids), 0) = 0 then raise exception 'Choose at least one charge to pay.' using errcode = '22023'; end if;
  if (select count(distinct x) from unnest(p_charge_ids) x) <> cardinality(p_charge_ids) then
    raise exception 'A charge was selected twice.' using errcode = '22023';
  end if;
  for v_charge in select * from public.charges where id = any (p_charge_ids) order by id loop
    if v_charge.member_id <> p_member_id then
      raise exception 'A member can only pay their own charges.' using errcode = '42501';
    end if;
    v_owed := app.charge_outstanding(v_charge.id);
    if v_owed <= 0 then raise exception '% is already paid.', v_charge.title using errcode = '22023'; end if;
    v_total := v_total + v_owed;
  end loop;
  if (select count(*) from public.charges where id = any (p_charge_ids)) <> cardinality(p_charge_ids) then
    raise exception 'Unknown charge.' using errcode = '22023';
  end if;
  insert into public.payment_attempts (group_id, reference, member_id, amount_kobo, provider, created_by, created_at, updated_at)
  values (app.group_id(), 'CL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)), p_member_id, v_total,
          (select s.payment_provider from app.settings s), auth.uid(), app.now(), app.now())
  returning * into v_attempt;
  insert into public.payment_attempt_charges (attempt_id, charge_id) select v_attempt.id, x from unnest(p_charge_ids) x;
  perform app.queue_analytics('payment started', 'payment started:' || v_attempt.id, p_member_id);
  perform app.audit('Payment started', format('%s · %s', v_attempt.reference, app.naira(v_total)));
  return v_attempt;
end $$;

-- Member: save what they chose to pay before checkout opens. The amount always
-- comes from the database, never from the browser.
create function public.start_payment_attempt(p_charge_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_member uuid := app.current_member_id();
  v_attempt public.payment_attempts;
begin
  if v_member is null then raise exception 'Sign in as a member to pay.' using errcode = '42501'; end if;
  v_attempt := app.create_attempt(v_member, p_charge_ids);
  return jsonb_build_object('attempt_id', v_attempt.id, 'reference', v_attempt.reference,
                            'amount_kobo', v_attempt.amount_kobo, 'currency', v_attempt.currency, 'provider', v_attempt.provider);
end $$;

-- Member: checkout closed before anything was submitted. Pending payments stay pending.
create function public.abandon_payment_attempt(p_attempt_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_status public.attempt_status;
begin
  update public.payment_attempts
     set status = 'abandoned', closed_reason = 'Checkout closed before payment', updated_at = app.now()
   where id = p_attempt_id and member_id = app.current_member_id() and status = 'started'
  returning status into v_status;
  if v_status is null then
    select status into v_status from public.payment_attempts where id = p_attempt_id and member_id = app.current_member_id();
    if v_status is null then raise exception 'Payment not found.' using errcode = '22023'; end if;
  else
    perform app.audit('Checkout closed', format('%s closed before payment. Nothing submitted.', p_attempt_id));
  end if;
  return v_status::text;
end $$;

-- Server: the hosted checkout page was created for this attempt.
create function public.server_record_checkout_session(p_reference text, p_authorization_url text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_trusted();
  update public.payment_attempts
     set authorization_url = p_authorization_url, checkout_opened_at = app.now(), updated_at = app.now()
   where reference = p_reference and status = 'started';
end $$;

-- Server: the provider could not open a checkout (e.g. outage). Nothing was submitted.
create function public.server_close_unopened_attempt(p_reference text, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_trusted();
  update public.payment_attempts
     set status = 'abandoned', closed_reason = left(p_reason, 200), updated_at = app.now()
   where reference = p_reference and status = 'started';
  perform app.audit('Checkout not opened', format('%s: %s', p_reference, left(p_reason, 200)), 'system');
end $$;

-- Server: a verified provider status other than success. Never credits money.
create function public.server_record_provider_status(p_reference text, p_provider_status text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_a public.payment_attempts;
  v_new public.attempt_status;
begin
  perform app.require_trusted();
  select * into v_a from public.payment_attempts where reference = p_reference for update;
  if v_a.id is null then return 'unknown-reference'; end if;
  v_new := v_a.status;
  if v_a.status <> 'confirmed' then
    if p_provider_status in ('failed', 'reversed') then v_new := 'failed';
    elsif p_provider_status = 'abandoned' and v_a.status in ('started', 'pending') then v_new := 'abandoned';
    elsif p_provider_status in ('pending', 'ongoing', 'processing', 'queued') and v_a.status in ('started', 'pending') then v_new := 'pending';
    end if;
  end if;
  update public.payment_attempts
     set status = v_new, last_provider_status = left(p_provider_status, 40), last_checked_at = app.now(),
         verification_checks = verification_checks + 1, updated_at = app.now(),
         closed_reason = case when v_new = 'abandoned' and v_a.status <> 'abandoned' then 'Provider reported the checkout was abandoned' else closed_reason end
   where id = v_a.id;
  if v_new <> v_a.status then
    perform app.audit('Payment status', format('%s: %s → %s (provider said %s). Nothing credited.', v_a.reference, v_a.status, v_new, p_provider_status), 'system');
  end if;
  return v_new::text;
end $$;

-- ---------------------------------------------------------------- payment posting

create function app.hold_event(p_provider text, p_provider_ref text, p_member_id uuid, p_reason text) returns void
language plpgsql set search_path = '' as $$
begin
  insert into public.tasks (key, type, member_id, ref_id, title, detail, created_at)
  values ('held:' || p_provider || ':' || p_provider_ref, 'held-event', p_member_id, p_provider_ref,
          'Payment held for checking', p_reason || ' Transaction ' || p_provider_ref || '. Nothing was credited.', app.now())
  on conflict (key) do nothing;
  perform app.audit('Payment held', p_provider_ref || ': ' || p_reason, 'system');
end $$;

-- Posts one verified provider payment in a single transaction: payment,
-- allocations (oldest due first, never beyond what is owed), excess kept as
-- credit for review, one receipt, reminder cancellation, task updates, audit and
-- the "payment confirmed" analytics event. A repeat of the same provider
-- transaction changes nothing. Row locks on the attempt and its charges
-- serialise concurrent postings for the same dues.
create function app.post_payment(p_provider text, p_provider_ref text, p_reference text, p_amount_kobo bigint, p_currency text,
                                 p_paid_at timestamptz, p_transaction_id text, p_environment text, p_source text) returns jsonb
language plpgsql set search_path = '' as $$
declare
  v_attempt public.payment_attempts;
  v_existing public.payments;
  v_payment public.payments;
  v_remaining bigint;
  v_charge public.charges;
  v_owed bigint;
  v_amount bigint;
  v_allocs integer := 0;
  v_receipt public.receipts;
  v_cancelled integer;
  v_other public.payment_attempts;
begin
  select * into v_attempt from public.payment_attempts where reference = p_reference for update;

  select * into v_existing from public.payments where provider = p_provider and provider_ref = p_provider_ref;
  if v_existing.id is not null then
    perform app.audit('Duplicate confirmation ignored', p_provider_ref, 'system');
    return jsonb_build_object('outcome', 'duplicate-ignored', 'payment_id', v_existing.id,
                              'receipt_id', (select r.id from public.receipts r where r.payment_id = v_existing.id));
  end if;

  if v_attempt.id is null then
    perform app.hold_event(p_provider, p_provider_ref, null, 'The payment reference does not match any attempt.');
    return jsonb_build_object('outcome', 'held', 'reason', 'unknown-reference');
  end if;
  if p_environment is distinct from 'test' or (select s.environment from app.settings s) <> 'test' then
    perform app.hold_event(p_provider, p_provider_ref, v_attempt.member_id, 'The payment is not from the test environment.');
    return jsonb_build_object('outcome', 'held', 'reason', 'environment');
  end if;
  if p_currency is distinct from 'NGN' then
    perform app.hold_event(p_provider, p_provider_ref, v_attempt.member_id, format('Unexpected currency %s.', p_currency));
    return jsonb_build_object('outcome', 'held', 'reason', 'currency');
  end if;
  if p_amount_kobo is distinct from v_attempt.amount_kobo then
    perform app.hold_event(p_provider, p_provider_ref, v_attempt.member_id,
      format('Amount %s does not match the expected %s.', app.naira(coalesce(p_amount_kobo, 0)), app.naira(v_attempt.amount_kobo)));
    return jsonb_build_object('outcome', 'held', 'reason', 'amount');
  end if;
  if p_provider is distinct from v_attempt.provider and p_source = 'provider' then
    perform app.hold_event(p_provider, p_provider_ref, v_attempt.member_id, 'The payment came from a different provider than the attempt.');
    return jsonb_build_object('outcome', 'held', 'reason', 'provider');
  end if;

  insert into public.payments (group_id, provider, provider_ref, provider_transaction_id, attempt_id, member_id, amount_kobo,
                               currency, environment, source, paid_at, confirmed_at)
  values (app.group_id(), p_provider, p_provider_ref, p_transaction_id, v_attempt.id, v_attempt.member_id, p_amount_kobo,
          'NGN', 'test', p_source, p_paid_at, app.now())
  returning * into v_payment;

  update public.payment_attempts set status = 'confirmed', updated_at = app.now() where id = v_attempt.id;

  -- Lock the chosen charges in a fixed order, then allocate against current balances.
  perform 1 from public.charges c where c.id in (select charge_id from public.payment_attempt_charges where attempt_id = v_attempt.id)
    order by c.id for update;
  v_remaining := v_payment.amount_kobo;
  for v_charge in select c.* from public.charges c
                  join public.payment_attempt_charges pac on pac.charge_id = c.id
                  where pac.attempt_id = v_attempt.id order by c.due_date, c.id loop
    exit when v_remaining = 0;
    v_owed := app.charge_outstanding(v_charge.id);
    v_amount := least(v_owed, v_remaining);
    continue when v_amount <= 0;
    insert into public.allocations (payment_id, charge_id, amount_kobo, created_at) values (v_payment.id, v_charge.id, v_amount, app.now());
    v_allocs := v_allocs + 1;
    v_remaining := v_remaining - v_amount;
  end loop;

  if v_remaining > 0 then
    insert into public.tasks (key, type, member_id, ref_id, title, detail, created_at)
    values ('credit:' || v_payment.id, 'unapplied-credit', v_payment.member_id, v_payment.id::text, 'Extra payment kept as credit',
            format('%s of %s was more than the member owed on the chosen dues. It is held as credit. The group has not decided whether to refund it or carry it forward.',
                   app.naira(v_remaining), p_provider_ref),
            app.now());
  end if;

  insert into public.receipts (payment_id, member_id, number, issued_at, amount_kobo, unapplied_kobo)
  values (v_payment.id, v_payment.member_id,
          format('%s-%s-%s', (select s.receipt_prefix from app.settings s), to_char(app.lagos_date(app.now()), 'YYYY'),
                 lpad(nextval('app.receipt_seq')::text, 4, '0')),
          app.now(), v_payment.amount_kobo, v_remaining)
  returning * into v_receipt;

  v_cancelled := app.cancel_reminders_for_paid(array(select charge_id from public.payment_attempt_charges where attempt_id = v_attempt.id),
                                               'Paid before sending');

  update public.tasks set status = 'resolved', closed_at = app.now(), close_note = 'Payment confirmed automatically.'
   where key = 'unresolved:' || v_attempt.id and status = 'open';

  for v_other in select distinct pa.* from public.payment_attempts pa
                 join public.payment_attempt_charges pac on pac.attempt_id = pa.id
                 where pa.status = 'pending' and pa.id <> v_attempt.id
                   and pac.charge_id in (select charge_id from public.payment_attempt_charges where attempt_id = v_attempt.id) loop
    if app.attempt_settled(v_other.id) then
      perform app.audit('Earlier payment still unconfirmed',
        format('%s: its dues are now paid by %s. If it is confirmed it will be kept as credit.', v_other.reference, p_provider_ref), 'system');
    end if;
  end loop;

  if p_source = 'provider' then
    perform app.queue_analytics('payment confirmed', 'payment confirmed:' || v_payment.id, v_payment.member_id);
  end if;
  perform app.audit('Payment recorded', format('%s · %s · %s allocation(s) · %s reminder(s) cancelled%s',
    p_provider_ref, app.naira(v_payment.amount_kobo), v_allocs, v_cancelled,
    case when v_remaining > 0 then ' · ' || app.naira(v_remaining) || ' kept as credit' else '' end), 'system');

  return jsonb_build_object('outcome', 'recorded', 'payment_id', v_payment.id, 'receipt_id', v_receipt.id,
                            'unapplied_kobo', v_remaining, 'allocations', v_allocs);
end $$;

-- Server only: called after the provider's own API has verified the transaction.
create function public.server_post_verified_payment(p_provider text, p_provider_ref text, p_reference text, p_amount_kobo bigint,
                                                    p_currency text, p_paid_at timestamptz, p_transaction_id text, p_environment text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_trusted();
  return app.post_payment(p_provider, p_provider_ref, p_reference, p_amount_kobo, p_currency, p_paid_at, p_transaction_id, p_environment, 'provider');
end $$;

-- Officer or server: an approved historical payment (fictional in this system).
create function public.record_opening_payment(p_member_id uuid, p_charge_id uuid, p_amount_kobo bigint, p_note text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_attempt public.payment_attempts;
  v_ref text := 'OPENING-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
begin
  perform app.require_officer();
  if (select member_id from public.charges where id = p_charge_id) is distinct from p_member_id then
    raise exception 'The charge does not belong to that member.' using errcode = '22023';
  end if;
  if p_amount_kobo <= 0 or p_amount_kobo > app.charge_outstanding(p_charge_id) then
    raise exception 'An opening payment must be above ₦0 and no more than what is owed.' using errcode = '22023';
  end if;
  insert into public.payment_attempts (group_id, reference, member_id, amount_kobo, provider, status, closed_reason, created_by, created_at, updated_at)
  values (app.group_id(), v_ref, p_member_id, p_amount_kobo, 'opening-record', 'started', left(p_note, 200), auth.uid(), app.now(), app.now())
  returning * into v_attempt;
  insert into public.payment_attempt_charges (attempt_id, charge_id) values (v_attempt.id, p_charge_id);
  return app.post_payment('opening-record', v_ref, v_ref, p_amount_kobo, 'NGN', app.now(), null, 'test', 'opening-record');
end $$;

-- ---------------------------------------------------------------- provider event inbox (server only)

-- Durably records a webhook event before it is acknowledged. A repeat is a no-op.
create function public.server_record_provider_event(p_provider text, p_dedupe_key text, p_event_type text, p_reference text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform app.require_trusted();
  insert into app.provider_events (provider, dedupe_key, event_type, reference, payload)
  values (p_provider, p_dedupe_key, p_event_type, p_reference, p_payload)
  on conflict (provider, dedupe_key) do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from app.provider_events where provider = p_provider and dedupe_key = p_dedupe_key;
    return jsonb_build_object('id', v_id, 'is_new', false);
  end if;
  return jsonb_build_object('id', v_id, 'is_new', true);
end $$;

-- Claims events that are due, including ones whose previous worker stopped
-- mid-way (expired lease). Concurrent workers never claim the same event.
create function public.server_claim_provider_events(p_limit integer, p_lease_seconds integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  perform app.require_trusted();
  with due as (
    select e.id from app.provider_events e
    where (e.status = 'received' and e.next_attempt_at <= now())
       or (e.status = 'processing' and e.lease_until < now())
    order by e.received_at
    limit greatest(p_limit, 1)
    for update skip locked
  ), claimed as (
    update app.provider_events e
       set status = 'processing', attempts = e.attempts + 1, lease_until = now() + make_interval(secs => p_lease_seconds)
      from due where e.id = due.id
    returning e.id, e.provider, e.event_type, e.reference, e.payload, e.attempts
  )
  select coalesce(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb) into v_rows from claimed;
  return v_rows;
end $$;

-- Finishes a claimed event. 'retry' backs off and, after 8 tries, raises a task.
create function public.server_finish_provider_event(p_id uuid, p_result text, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_e app.provider_events;
begin
  perform app.require_trusted();
  select * into v_e from app.provider_events where id = p_id for update;
  if v_e.id is null then raise exception 'Unknown event.'; end if;
  if p_result in ('processed', 'held', 'ignored') then
    update app.provider_events set status = p_result, outcome = left(p_note, 500), processed_at = now(), lease_until = null, last_error = null where id = p_id;
  elsif p_result = 'retry' then
    if v_e.attempts >= 8 then
      update app.provider_events set status = 'failed', last_error = left(p_note, 500), lease_until = null where id = p_id;
      insert into public.tasks (key, type, ref_id, title, detail, created_at)
      values ('event-failed:' || p_id, 'event-failed', v_e.reference, 'Payment event could not be processed',
              format('A %s event for reference %s failed %s times: %s. Nothing was credited from it.', v_e.provider, coalesce(v_e.reference, 'unknown'), v_e.attempts, left(p_note, 200)),
              app.now())
      on conflict (key) do nothing;
    else
      update app.provider_events
         set status = 'received', last_error = left(p_note, 500), lease_until = null,
             next_attempt_at = now() + least(interval '6 hours', make_interval(secs => 30 * power(2, v_e.attempts)::int))
       where id = p_id;
    end if;
  else
    raise exception 'Unknown result %', p_result;
  end if;
end $$;

-- Attempts that need a provider status check (e.g. webhook never arrived).
create function public.server_attempts_to_reconcile(p_older_than_seconds integer, p_limit integer) returns jsonb
language sql security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('reference', pa.reference, 'provider', pa.provider, 'status', pa.status)), '[]'::jsonb)
  from (select * from public.payment_attempts
        where status in ('started', 'pending') and provider not in ('opening-record')
          and checkout_opened_at is not null
          and coalesce(last_checked_at, checkout_opened_at) <= app.now() - make_interval(secs => p_older_than_seconds)
          and app.is_trusted()
        order by coalesce(last_checked_at, checkout_opened_at) limit p_limit) pa
$$;

-- ---------------------------------------------------------------- analytics delivery (server only)

create function public.server_claim_analytics_events(p_limit integer, p_lease_seconds integer) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_rows jsonb;
begin
  perform app.require_trusted();
  with due as (
    select a.id from app.analytics_outbox a
    where (a.status = 'pending' and a.next_attempt_at <= now()) or (a.status = 'sending' and a.lease_until < now())
    order by a.occurred_at limit greatest(p_limit, 1) for update skip locked
  ), claimed as (
    update app.analytics_outbox a set status = 'sending', attempts = a.attempts + 1, lease_until = now() + make_interval(secs => p_lease_seconds)
    from due where a.id = due.id
    returning a.id, a.event, a.distinct_id, a.properties, a.occurred_at
  )
  select coalesce(jsonb_agg(to_jsonb(claimed)), '[]'::jsonb) into v_rows from claimed;
  return v_rows;
end $$;

create function public.server_finish_analytics_event(p_id uuid, p_ok boolean, p_error text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_trusted();
  if p_ok then
    update app.analytics_outbox set status = 'sent', sent_at = now(), lease_until = null, last_error = null where id = p_id;
  else
    update app.analytics_outbox
       set status = case when attempts >= 10 then 'failed' else 'pending' end, lease_until = null, last_error = left(p_error, 300),
           next_attempt_at = now() + least(interval '6 hours', make_interval(secs => 60 * power(2, attempts)::int))
     where id = p_id;
  end if;
end $$;

-- ---------------------------------------------------------------- tasks, reports, admin

create function public.report_discrepancy(p_message text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_member uuid := app.current_member_id();
  v_id uuid := gen_random_uuid();
begin
  if v_member is null then raise exception 'Sign in as a member to report a problem.' using errcode = '42501'; end if;
  if coalesce(trim(p_message), '') = '' then raise exception 'Tell us what looks wrong.' using errcode = '22023'; end if;
  insert into public.tasks (id, key, type, member_id, title, detail, created_at)
  values (v_id, 'discrepancy:' || v_id, 'discrepancy', v_member, 'Member reported a problem', left(trim(p_message), 500), app.now());
  -- The member's free text stays in the ledger; analytics gets only the event name.
  perform app.queue_analytics('discrepancy reported', 'discrepancy reported:' || v_id, v_member);
  perform app.audit('Problem reported', 'Sent to Needs attention');
  return v_id;
end $$;

create function public.review_task(p_task_id uuid, p_note text) returns void
language plpgsql security definer set search_path = '' as $$
declare v_title text;
begin
  perform app.require_officer();
  update public.tasks
     set status = 'reviewed', closed_at = app.now(), closed_by = auth.uid(),
         close_note = coalesce(nullif(trim(p_note), ''), 'Reviewed. No change to records.')
   where id = p_task_id and status = 'open'
  returning title into v_title;
  if v_title is not null then
    perform app.audit('Task reviewed', v_title || ': ' || coalesce(nullif(trim(p_note), ''), 'Reviewed. No change to records.'));
  end if;
end $$;

-- Officer collection report. Payments are summed from the payments table, not
-- from joined allocation rows, so a payment covering several charges counts once.
create function public.collection_report() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_assessed bigint; v_collected bigint; v_allocated bigint; v_unapplied bigint; v_outstanding bigint; v_overdue bigint;
  v_member_outstanding bigint; v_member_payments bigint;
begin
  perform app.require_officer();
  select coalesce(sum(c.amount_kobo + app.charge_adjusted(c.id)), 0) into v_assessed from public.charges c;
  select coalesce(sum(p.amount_kobo), 0) into v_collected from public.payments p;
  select coalesce(sum(a.amount_kobo), 0) into v_allocated from public.allocations a;
  select coalesce(sum(app.payment_unapplied(p.id)), 0) into v_unapplied from public.payments p;
  select coalesce(sum(app.charge_outstanding(c.id)), 0),
         coalesce(sum(app.charge_outstanding(c.id)) filter (where app.charge_status(c.id, app.now()) = 'overdue'), 0)
    into v_outstanding, v_overdue from public.charges c;
  select coalesce(sum(outstanding_kobo), 0) into v_member_outstanding from public.member_balances;
  select coalesce(sum(m.total), 0) into v_member_payments
    from (select sum(p.amount_kobo) as total from public.payments p group by p.member_id) m;
  return jsonb_build_object(
    'as_of', app.now(),
    'assessed_kobo', v_assessed, 'collected_kobo', v_collected, 'allocated_kobo', v_allocated,
    'unapplied_kobo', v_unapplied, 'outstanding_kobo', v_outstanding, 'overdue_kobo', v_overdue,
    'pending_attempts', (select count(*) from public.payment_attempts where status = 'pending'),
    'pending_attempts_kobo', (select coalesce(sum(amount_kobo), 0) from public.payment_attempts where status = 'pending'),
    'groups', (select coalesce(jsonb_agg(g order by g.title), '[]'::jsonb) from (
        select c.title, count(*) as members, sum(c.amount_kobo + app.charge_adjusted(c.id)) as assessed_kobo,
               sum(app.charge_allocated(c.id)) as allocated_kobo, sum(app.charge_outstanding(c.id)) as outstanding_kobo,
               coalesce(sum(app.charge_outstanding(c.id)) filter (where app.charge_status(c.id, app.now()) = 'overdue'), 0) as overdue_kobo
        from public.charges c group by c.title) g),
    'checks', jsonb_build_array(
      jsonb_build_object('label', 'Assessed minus applied payments equals outstanding', 'ok', v_assessed - v_allocated = v_outstanding),
      jsonb_build_object('label', 'Payments received equal applied plus credit', 'ok', v_collected = v_allocated + v_unapplied),
      jsonb_build_object('label', 'Member statements add up to the group total', 'ok', v_member_outstanding = v_outstanding),
      jsonb_build_object('label', 'Each payment counted once', 'ok', v_member_payments = v_collected),
      jsonb_build_object('label', 'One receipt per payment', 'ok', (select count(*) from public.receipts) = (select count(*) from public.payments))
    ));
end $$;

-- Administration (server/admin only, never officers or members): link a
-- sign-in account to a member, and grant officer status.
create function public.server_link_member_user(p_member_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_trusted();
  update public.members set user_id = p_user_id where id = p_member_id;
  perform app.audit('Account linked', format('Member %s linked to a sign-in account', p_member_id), 'system');
end $$;

create function public.server_grant_officer(p_user_id uuid, p_granted_by text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_trusted();
  insert into public.officers (user_id, group_id, granted_at, granted_by) values (p_user_id, app.group_id(), app.now(), p_granted_by)
  on conflict (user_id) do nothing;
  perform app.audit('Officer granted', format('Officer access granted by %s', p_granted_by), 'system');
end $$;

-- Test clock (test environment only). Server/admin only.
create function public.server_set_test_clock(p_at timestamptz) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_trusted();
  update app.settings set clock_override = p_at where environment = 'test';
end $$;
