-- Community Ledger · verification mismatches become durable officer tasks
--
-- When the provider's verification answer names a different reference from
-- the attempt we asked about, nothing is credited. This records one
-- Needs attention task per expected attempt and reported transaction, so
-- retries (worker or member return) never create duplicates, and audits it.

create function public.server_hold_verification_mismatch(p_provider text, p_expected_reference text, p_reported_reference text,
                                                         p_provider_ref text, p_source text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_attempt public.payment_attempts;
  v_key text;
  v_task uuid;
begin
  perform app.require_trusted();
  select * into v_attempt from public.payment_attempts where reference = p_expected_reference;
  v_key := 'mismatch:' || p_provider || ':' || p_expected_reference || ':'
           || coalesce(nullif(p_provider_ref, ''), nullif(p_reported_reference, ''), 'unknown');
  insert into public.tasks (key, type, member_id, ref_id, title, detail, created_at)
  values (v_key, 'held-event', v_attempt.member_id, coalesce(v_attempt.id::text, p_expected_reference),
          'Payment check returned a different reference',
          format('We asked the provider about %s but its answer was for %s%s. Nothing was credited. Found during %s.',
                 p_expected_reference, coalesce(nullif(p_reported_reference, ''), 'an unknown reference'),
                 case when coalesce(p_provider_ref, '') <> '' then ' (transaction ' || p_provider_ref || ')' else '' end,
                 case when p_source = 'return' then 'a member returning from checkout' else 'payment processing' end),
          app.now())
  on conflict (key) do nothing
  returning id into v_task;
  if v_task is not null then
    perform app.audit('Payment held', format('Verification for %s returned %s. Nothing credited.', p_expected_reference,
                      coalesce(nullif(p_reported_reference, ''), 'an unknown reference')), 'system');
  end if;
  return jsonb_build_object('task_id', coalesce(v_task, (select id from public.tasks where key = v_key)), 'is_new', v_task is not null);
end $$;

revoke all on function public.server_hold_verification_mismatch(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.server_hold_verification_mismatch(text, text, text, text, text) to service_role;
