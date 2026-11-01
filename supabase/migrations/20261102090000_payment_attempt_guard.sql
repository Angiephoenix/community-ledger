-- One open payment per charge, and clearer wording in stored messages.
--
-- 1. Starting a payment for a charge that already has a submitted (pending)
--    payment being checked is refused while that payment is inside the
--    reminder pause (48 hours by default). Paying twice is how a member ends up
--    charged twice.
-- 2. After the pause, the earlier payment is flagged as unconfirmed and
--    reminders resume. The member may pay again, but only by saying so
--    (p_pay_again = true). If both payments go through, the second is kept as
--    credit for an officer to review (existing behaviour of app.post_payment).
-- 3. A checkout that was opened but never submitted (status 'started') for any
--    of the same charges is closed as abandoned when a new one starts, so each
--    charge has at most one open checkout. If that older page is still paid,
--    app.post_payment records it anyway (it accepts any attempt status) and the
--    excess becomes credit for review.
-- 4. Attempts for one member are created one at a time (advisory lock), so two
--    quick clicks cannot race past these checks.
--
-- Wording only: the unconfirmed-payment task says "48 hours" rather than the
-- raw interval "48:00:00", and account-link audit lines name the member.
-- Existing stored rows are left unchanged (the audit trail is append-only).

drop function public.start_payment_attempt(uuid[]);
drop function app.create_attempt(uuid, uuid[]);

create function app.interval_words(p interval) returns text
language sql immutable set search_path = '' as $$
  select case
    when extract(epoch from p) % 3600 = 0 then
      (extract(epoch from p) / 3600)::bigint || case when extract(epoch from p) = 3600 then ' hour' else ' hours' end
    else p::text end
$$;

create function app.create_attempt(p_member_id uuid, p_charge_ids uuid[], p_pay_again boolean default false) returns public.payment_attempts
language plpgsql set search_path = '' as $$
declare
  v_attempt public.payment_attempts;
  v_total bigint := 0;
  v_charge public.charges;
  v_owed bigint;
  v_open record;
begin
  if coalesce(cardinality(p_charge_ids), 0) = 0 then raise exception 'Choose at least one charge to pay.' using errcode = '22023'; end if;
  if (select count(distinct x) from unnest(p_charge_ids) x) <> cardinality(p_charge_ids) then
    raise exception 'A charge was selected twice.' using errcode = '22023';
  end if;

  -- One attempt at a time per member.
  perform pg_advisory_xact_lock(hashtextextended('payment-attempt:' || p_member_id::text, 0));

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

  -- A submitted payment for any of these charges that is still being checked.
  select pa.reference, c.title, app.now() - pa.created_at < app.pending_pause() as within_pause
    into v_open
    from public.payment_attempts pa
    join public.payment_attempt_charges pac on pac.attempt_id = pa.id
    join public.charges c on c.id = pac.charge_id
   where pa.status = 'pending' and pac.charge_id = any (p_charge_ids)
   order by within_pause desc, pa.created_at
   limit 1;
  if found then
    if v_open.within_pause then
      raise exception 'A payment for % is still being checked (%). You can pay again if it is not confirmed within %.',
        v_open.title, v_open.reference, app.interval_words(app.pending_pause()) using errcode = '55000';
    elsif not coalesce(p_pay_again, false) then
      raise exception 'An earlier payment for % (%) has not been confirmed. Choose to pay again to continue.',
        v_open.title, v_open.reference using errcode = '55000';
    end if;
  end if;

  insert into public.payment_attempts (group_id, reference, member_id, amount_kobo, provider, created_by, created_at, updated_at)
  values (app.group_id(), 'CL-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 16)), p_member_id, v_total,
          (select s.payment_provider from app.settings s), auth.uid(), app.now(), app.now())
  returning * into v_attempt;
  insert into public.payment_attempt_charges (attempt_id, charge_id) select v_attempt.id, x from unnest(p_charge_ids) x;

  -- Close older checkouts for the same charges that were never submitted.
  update public.payment_attempts pa
     set status = 'abandoned', closed_reason = 'Replaced by a newer checkout ' || v_attempt.reference, updated_at = app.now()
   where pa.member_id = p_member_id and pa.status = 'started' and pa.id <> v_attempt.id
     and exists (select 1 from public.payment_attempt_charges pac where pac.attempt_id = pa.id and pac.charge_id = any (p_charge_ids));

  perform app.queue_analytics('payment started', 'payment started:' || v_attempt.id, p_member_id);
  perform app.audit('Payment started', format('%s · %s', v_attempt.reference, app.naira(v_total)));
  return v_attempt;
end $$;

-- Member: save what they chose to pay before checkout opens. The amount always
-- comes from the database, never from the browser.
create function public.start_payment_attempt(p_charge_ids uuid[], p_pay_again boolean default false) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_member uuid := app.current_member_id();
  v_attempt public.payment_attempts;
begin
  if v_member is null then raise exception 'Sign in as a member to pay.' using errcode = '42501'; end if;
  v_attempt := app.create_attempt(v_member, p_charge_ids, p_pay_again);
  return jsonb_build_object('attempt_id', v_attempt.id, 'reference', v_attempt.reference,
                            'amount_kobo', v_attempt.amount_kobo, 'currency', v_attempt.currency, 'provider', v_attempt.provider);
end $$;

create or replace function app.flag_unresolved_attempts() returns integer
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
                   v_a.reference, app.naira(v_a.amount_kobo), app.interval_words(app.pending_pause()))
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

create or replace function public.server_link_member_user(p_member_id uuid, p_user_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform app.require_trusted();
  update public.members set user_id = p_user_id where id = p_member_id;
  perform app.audit('Account linked',
    format('%s linked to a sign-in account', coalesce((select m.display_name from public.members m where m.id = p_member_id), 'Member ' || p_member_id)),
    'system');
end $$;

-- Privileges: start closed, then grant exactly what the earlier migrations granted.
revoke all on function app.interval_words(interval) from public, anon, authenticated, service_role;
revoke all on function app.create_attempt(uuid, uuid[], boolean) from public, anon, authenticated, service_role;
revoke all on function public.start_payment_attempt(uuid[], boolean) from public, anon, authenticated, service_role;
grant execute on function public.start_payment_attempt(uuid[], boolean) to authenticated;
