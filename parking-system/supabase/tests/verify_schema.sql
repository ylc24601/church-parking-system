-- Phase 1 schema verification. Run AFTER `supabase db reset` (migrations + seed):
--   psql "$LOCAL_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/verify_schema.sql
-- Every block either prints PASS or raises (aborting with non-zero exit). All work
-- happens inside a transaction that is rolled back, so the DB returns to seed state.

\set ON_ERROR_STOP on

begin;

-- Scratch event/users to keep negative tests off the seeded rows.
insert into weekly_events (id, sunday_date, total_capacity, blocked_spaces, admin_reserved)
  values ('e0000000-0000-0000-0000-000000000002', '2026-06-28', 23, 0, 0);

-- ── 1. Normalized-plate collision rejected ────────────────────────────────────
-- Since 0038 this uniqueness is scoped to ACTIVE rows (the seeded row is active, so the
-- assertion is unchanged). The other half — that an INACTIVE row is free to duplicate a
-- plate, which is what makes a plate re-issuable — is asserted in §42e.
do $$
begin
  insert into vehicles (user_id, license_plate)
    values ('a0000000-0000-0000-0000-000000000003', 'abc1234');  -- normalizes to ABC1234 == ABC-1234
  raise exception 'FAIL: normalized plate collision was allowed';
exception when unique_violation then
  raise notice 'PASS: normalized plate collision rejected';
end $$;

-- ── 2. Duplicate (weekly_event_id, user_id) staff allocation rejected ─────────
do $$
begin
  insert into weekly_staff_allocations (weekly_event_id, user_id, status)
    values ('e0000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'reserved');
  raise exception 'FAIL: duplicate staff allocation was allowed';
exception when unique_violation then
  raise notice 'PASS: duplicate staff allocation rejected';
end $$;

-- ── 3. Second active reservation for same (event, member) rejected ────────────
do $$
begin
  insert into reservations (weekly_event_id, user_id, vehicle_id, effective_priority, status)
    values ('e0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000003',
            'b0000000-0000-0000-0000-000000000003', 3, 'pending');
  raise exception 'FAIL: second active reservation was allowed';
exception when unique_violation then
  raise notice 'PASS: one-active-reservation-per-member enforced';
end $$;

-- ── 4. Approved reservation with NULL release_deadline_at rejected (Seam 1) ───
do $$
begin
  insert into reservations (weekly_event_id, user_id, vehicle_id, effective_priority, status, release_deadline_at)
    values ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003',
            'b0000000-0000-0000-0000-000000000003', 3, 'approved', null);
  raise exception 'FAIL: approved row without release_deadline_at was allowed';
exception when check_violation then
  raise notice 'PASS: approved row requires release_deadline_at';
end $$;

-- ── 5. Member reservation whose vehicle belongs to another user rejected (Seam 3) ─
do $$
begin
  insert into reservations (weekly_event_id, user_id, vehicle_id, effective_priority, status)
    values ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000004',
            'b0000000-0000-0000-0000-000000000003', 3, 'pending');  -- vehicle b..03 belongs to member 3
  raise exception 'FAIL: cross-user vehicle reservation was allowed';
exception when foreign_key_violation then
  raise notice 'PASS: vehicle must belong to the reserving user';
end $$;

-- ── 6. Member reservation with NULL vehicle_id rejected (member-shape check) ──
do $$
begin
  insert into reservations (weekly_event_id, user_id, vehicle_id, effective_priority, status)
    values ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000005',
            null, 3, 'pending');
  raise exception 'FAIL: member reservation without vehicle was allowed';
exception when check_violation then
  raise notice 'PASS: member reservation requires a vehicle';
end $$;

-- ── 7. Multiple users with NULL line_id allowed (partial unique index) ────────
do $$
begin
  insert into users (display_name, role) values ('未綁定A', 'staff');
  insert into users (display_name, role) values ('未綁定B', 'staff');
  raise notice 'PASS: multiple NULL line_id users allowed';
end $$;

-- ── 8. effective_priority outside (1,2,3) rejected ────────────────────────────
do $$
begin
  insert into reservations (weekly_event_id, user_id, vehicle_id, effective_priority, status)
    values ('e0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000005',
            'b0000000-0000-0000-0000-000000000005', 4, 'pending');
  raise exception 'FAIL: effective_priority=4 was allowed';
exception when check_violation then
  raise notice 'PASS: effective_priority constrained to 1..3';
end $$;

-- ── 9. Walk-in without a plate rejected ───────────────────────────────────────
do $$
begin
  insert into reservations (weekly_event_id, effective_priority, status)
    values ('e0000000-0000-0000-0000-000000000002', 3, 'walk_in');
  raise exception 'FAIL: walk-in without plate was allowed';
exception when check_violation then
  raise notice 'PASS: walk-in requires a license plate';
end $$;

-- ── 10. v_weekly_capacity_inputs reports active P1 = 1 for the seeded event ────
do $$
declare v int;
begin
  select active_full_time_staff_reserved into v from v_weekly_capacity_inputs
    where weekly_event_id = 'e0000000-0000-0000-0000-000000000001';
  if v <> 1 then raise exception 'FAIL: expected active P1 = 1, got %', v; end if;
  raise notice 'PASS: v_weekly_capacity_inputs active P1 = 1';
end $$;

-- ── 11. staff_checkin_view exposes is_priority, hides reason/penalty ───────────
do $$
declare leaked int;
begin
  select count(*) into leaked from information_schema.columns
    where table_name = 'staff_checkin_view'
      and column_name in ('p2_reason', 'penalty_score', 'consecutive_no_show', 'effective_priority');
  if leaked <> 0 then raise exception 'FAIL: staff_checkin_view leaks % sensitive column(s)', leaked; end if;
  perform 1 from information_schema.columns
    where table_name = 'staff_checkin_view' and column_name = 'is_priority';
  if not found then raise exception 'FAIL: staff_checkin_view missing is_priority'; end if;
  raise notice 'PASS: staff_checkin_view exposes is_priority, no sensitive columns';
end $$;

-- ── 12. At most one OPEN pastoral_care_alert per user ─────────────────────────
do $$
begin
  insert into pastoral_care_alerts (user_id, weekly_event_id, reason, trigger_count)
    values ('a0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000002', 'consecutive_no_show', 4);
  insert into pastoral_care_alerts (user_id, weekly_event_id, reason, trigger_count)
    values ('a0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000002', 'consecutive_no_show', 5);
  raise exception 'FAIL: a second open pastoral_care_alert was allowed';
exception when unique_violation then
  raise notice 'PASS: only one open pastoral_care_alert per user';
end $$;

-- ── 13. Duplicate normalized walk-in plate per event rejected (Phase 3 v2) ─────
do $$
begin
  insert into reservations (weekly_event_id, walk_in_license_plate, effective_priority, status)
    values ('e0000000-0000-0000-0000-000000000002', 'WK-1234', 3, 'walk_in');
  insert into reservations (weekly_event_id, walk_in_license_plate, effective_priority, status)
    values ('e0000000-0000-0000-0000-000000000002', 'wk1234', 3, 'walk_in');  -- normalizes to WK1234
  raise exception 'FAIL: duplicate normalized walk-in plate was allowed';
exception when unique_violation then
  raise notice 'PASS: duplicate normalized walk-in plate per event rejected';
end $$;

-- ── 14. staff_sessions: one PIN row per weekly_event (Phase 3 v2 PIN session) ──
do $$
begin
  insert into staff_sessions (weekly_event_id, pin_hash, expires_at)
    values ('e0000000-0000-0000-0000-000000000002', 'scrypt$00$00', now() + interval '12 hours');
  insert into staff_sessions (weekly_event_id, pin_hash, expires_at)
    values ('e0000000-0000-0000-0000-000000000002', 'scrypt$11$11', now() + interval '12 hours');
  raise exception 'FAIL: a second staff_sessions row for the same event was allowed';
exception when unique_violation then
  raise notice 'PASS: staff_sessions unique per weekly_event';
end $$;

-- ── 15. apply_staff_pin_failure exists + service_role can execute (Phase 3 v2) ─
do $$
begin
  perform 1 from pg_proc where proname = 'apply_staff_pin_failure';
  if not found then raise exception 'FAIL: apply_staff_pin_failure function missing'; end if;
  if not has_function_privilege('service_role', 'apply_staff_pin_failure(uuid,int)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on apply_staff_pin_failure';
  end if;
  raise notice 'PASS: apply_staff_pin_failure present with service_role execute grant';
end $$;

-- ── 16. notification_outbox lease columns + 'processing' status (Phase 4 A) ────
do $$
declare missing int;
begin
  select count(*) into missing
    from (values ('locked_at'), ('locked_by'), ('last_error')) as want(col)
    where not exists (
      select 1 from information_schema.columns
        where table_name = 'notification_outbox' and column_name = want.col);
  if missing <> 0 then raise exception 'FAIL: notification_outbox missing % lease column(s)', missing; end if;
  perform 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'notification_status' and e.enumlabel = 'processing';
  if not found then raise exception 'FAIL: notification_status missing ''processing'' value'; end if;
  raise notice 'PASS: notification_outbox lease columns + processing status present';
end $$;

-- ── 17. claim_notification_outbox exists + service_role execute (Phase 4 A) ────
do $$
begin
  perform 1 from pg_proc where proname = 'claim_notification_outbox';
  if not found then raise exception 'FAIL: claim_notification_outbox function missing'; end if;
  if not has_function_privilege(
       'service_role', 'claim_notification_outbox(text,timestamptz,int,int)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on claim_notification_outbox';
  end if;
  raise notice 'PASS: claim_notification_outbox present with service_role execute grant';
end $$;

-- ── 18. staff_checkin_view exposes owner_notifiable, still hides line_id/phone (Phase 4 B) ─
do $$
declare leaked int;
begin
  perform 1 from information_schema.columns
    where table_name = 'staff_checkin_view' and column_name = 'owner_notifiable';
  if not found then raise exception 'FAIL: staff_checkin_view missing owner_notifiable'; end if;
  select count(*) into leaked from information_schema.columns
    where table_name = 'staff_checkin_view' and column_name in ('line_id', 'phone_number');
  if leaked <> 0 then raise exception 'FAIL: staff_checkin_view leaks % contact column(s)', leaked; end if;
  raise notice 'PASS: staff_checkin_view exposes owner_notifiable, hides line_id/phone';
end $$;

-- ── 19. outbox_health exists + service_role execute (Phase 4 C) ────────────────
do $$
begin
  perform 1 from pg_proc where proname = 'outbox_health';
  if not found then raise exception 'FAIL: outbox_health function missing'; end if;
  if not has_function_privilege('service_role', 'outbox_health(timestamptz,int)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on outbox_health';
  end if;
  raise notice 'PASS: outbox_health present with service_role execute grant';
end $$;

-- ── 20. apply_release 4-arg (owner notices) + 3-arg wrapper, service_role execute (Phase 4 D) ─
do $$
begin
  if not has_function_privilege('service_role', 'apply_release(uuid,timestamptz,jsonb,jsonb)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on 4-arg apply_release (owner notices)';
  end if;
  if not has_function_privilege('service_role', 'apply_release(uuid,timestamptz,jsonb)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on 3-arg apply_release wrapper';
  end if;
  raise notice 'PASS: apply_release 4-arg + 3-arg wrapper present with service_role execute grant';
end $$;

-- ── 21. apply_cancellation 8-arg (cancel notice) + 7-arg wrapper, service_role execute (Phase 4 E) ─
do $$
begin
  if not has_function_privilege('service_role', 'apply_cancellation(uuid,uuid,text,text,timestamptz,jsonb,jsonb,jsonb)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on 8-arg apply_cancellation (cancel notice)';
  end if;
  if not has_function_privilege('service_role', 'apply_cancellation(uuid,uuid,text,text,timestamptz,jsonb,jsonb)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on 7-arg apply_cancellation wrapper';
  end if;
  raise notice 'PASS: apply_cancellation 8-arg + 7-arg wrapper present with service_role execute grant';
end $$;

-- ── 22. requeue_failed_outbox exists + service_role execute (Phase 4 F) ─────────
do $$
begin
  perform 1 from pg_proc where proname = 'requeue_failed_outbox';
  if not found then raise exception 'FAIL: requeue_failed_outbox function missing'; end if;
  if not has_function_privilege('service_role', 'requeue_failed_outbox(timestamptz,int,text)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on requeue_failed_outbox';
  end if;
  raise notice 'PASS: requeue_failed_outbox present with service_role execute grant';
end $$;

-- ── 23. pending_binding table + partial unique index + capture RPC grant (Phase 5A) ─
do $$
begin
  perform 1 from pg_class where relname = 'pending_binding' and relkind = 'r';
  if not found then raise exception 'FAIL: pending_binding table missing'; end if;

  perform 1 from pg_indexes where indexname = 'pending_binding_active_uq';
  if not found then raise exception 'FAIL: pending_binding_active_uq partial unique index missing'; end if;

  perform 1 from pg_proc where proname = 'capture_pending_binding';
  if not found then raise exception 'FAIL: capture_pending_binding function missing'; end if;

  if not has_function_privilege('service_role', 'capture_pending_binding(text,text,text,timestamptz)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on capture_pending_binding';
  end if;
  if not has_table_privilege('service_role', 'pending_binding', 'insert') then
    raise exception 'FAIL: service_role lacks insert on pending_binding';
  end if;
  raise notice 'PASS: pending_binding table + active-uq index + capture_pending_binding grant present';
end $$;

-- ── 24. binding_codes + pending_binding audit cols + approve/reject RPC grants (Phase 5B) ─
do $$
begin
  perform 1 from pg_class where relname = 'binding_codes' and relkind = 'r';
  if not found then raise exception 'FAIL: binding_codes table missing'; end if;

  perform 1 from pg_indexes where indexname = 'binding_codes_code_key';
  if not found then raise exception 'FAIL: binding_codes_code_key unique index missing'; end if;

  -- pending_binding audit columns
  perform 1 from information_schema.columns
   where table_name = 'pending_binding'
     and column_name in ('approved_at', 'approved_user_id', 'rejected_at', 'rejected_reason')
   group by table_name having count(*) = 4;
  if not found then raise exception 'FAIL: pending_binding audit columns (approved_at/approved_user_id/rejected_at/rejected_reason) missing'; end if;

  perform 1 from pg_proc where proname = 'approve_pending_binding';
  if not found then raise exception 'FAIL: approve_pending_binding function missing'; end if;
  perform 1 from pg_proc where proname = 'reject_pending_binding';
  if not found then raise exception 'FAIL: reject_pending_binding function missing'; end if;

  -- 0022 re-signed approve_pending_binding to 4 args (expected-revision optimistic concurrency);
  -- 0025 re-signed both RPCs again with a defaulted p_admin_id (decider audit) — #27/#30
  -- also assert the stale overloads are gone.
  if not has_function_privilege('service_role', 'approve_pending_binding(uuid,bigint,timestamptz,boolean,uuid)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on approve_pending_binding';
  end if;
  if not has_function_privilege('service_role', 'reject_pending_binding(uuid,text,timestamptz,uuid)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on reject_pending_binding';
  end if;
  if not has_table_privilege('service_role', 'binding_codes', 'insert') then
    raise exception 'FAIL: service_role lacks insert on binding_codes';
  end if;
  raise notice 'PASS: binding_codes + pending_binding audit cols + approve/reject RPC grants present';
end $$;

-- ── 25. eligibility_dependents + users_phone_key + import_member RPC grant (Phase 6) ─
do $$
begin
  perform 1 from pg_type where typname = 'dependent_kind';
  if not found then raise exception 'FAIL: dependent_kind enum missing'; end if;

  perform 1 from pg_class where relname = 'eligibility_dependents' and relkind = 'r';
  if not found then raise exception 'FAIL: eligibility_dependents table missing'; end if;

  perform 1 from pg_indexes where indexname = 'eligibility_dependents_uq';
  if not found then raise exception 'FAIL: eligibility_dependents_uq unique index missing'; end if;

  perform 1 from pg_indexes where indexname = 'users_phone_key';
  if not found then raise exception 'FAIL: users_phone_key (phone identity) index missing'; end if;

  perform 1 from pg_proc where proname = 'import_member';
  if not found then raise exception 'FAIL: import_member function missing'; end if;
  if not has_function_privilege('service_role', 'import_member(text,text,text[],p2_reason,date,date,jsonb,boolean)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on import_member';
  end if;
  if not has_table_privilege('service_role', 'eligibility_dependents', 'insert') then
    raise exception 'FAIL: service_role lacks insert on eligibility_dependents';
  end if;
  raise notice 'PASS: eligibility_dependents + users_phone_key + import_member RPC grant present';
end $$;

-- ── 26. member_sessions table + hashed-token unique + RLS + grant (Phase 7 Slice 1) ─
do $$
begin
  perform 1 from pg_class where relname = 'member_sessions' and relkind = 'r';
  if not found then raise exception 'FAIL: member_sessions table missing'; end if;

  -- Cookie token is stored hashed; uniqueness on the hash is the lookup key.
  perform 1 from pg_indexes where indexname = 'member_sessions_token_hash_key';
  if not found then raise exception 'FAIL: member_sessions_token_hash_key unique index missing'; end if;

  perform 1 from pg_class where relname = 'member_sessions' and relrowsecurity;
  if not found then raise exception 'FAIL: member_sessions RLS not enabled'; end if;

  perform 1 from pg_constraint
    where conname = 'member_sessions_expiry_after_creation' and contype = 'c';
  if not found then raise exception 'FAIL: member_sessions_expiry_after_creation check missing'; end if;

  if not has_table_privilege('service_role', 'member_sessions', 'insert') then
    raise exception 'FAIL: service_role lacks insert on member_sessions';
  end if;
  if has_table_privilege('anon', 'member_sessions', 'select') then
    raise exception 'FAIL: anon must not read member_sessions';
  end if;
  raise notice 'PASS: member_sessions table + token_hash unique + RLS deny-all + service_role grant present';
end $$;

-- ── 27. LIFF binding claim: XOR shape + phone canon + capture/approve RPCs (Phase 7 Slice 2) ─
do $$
begin
  -- submitted_code relaxed to nullable (liff claims carry phone+name instead).
  perform 1 from information_schema.columns
    where table_name = 'pending_binding' and column_name = 'submitted_code' and is_nullable = 'YES';
  if not found then raise exception 'FAIL: pending_binding.submitted_code should be nullable'; end if;

  perform 1 from information_schema.columns
    where table_name = 'pending_binding' and column_name = 'claim_source'
      and column_default like '%keyword%';
  if not found then raise exception 'FAIL: pending_binding.claim_source default keyword missing'; end if;

  perform 1 from pg_constraint where conname = 'pending_binding_claim_source_ck' and contype = 'c';
  if not found then raise exception 'FAIL: pending_binding_claim_source_ck missing'; end if;
  perform 1 from pg_constraint where conname = 'pending_binding_claim_shape_ck' and contype = 'c';
  if not found then raise exception 'FAIL: pending_binding_claim_shape_ck (strict XOR) missing'; end if;
  perform 1 from pg_constraint where conname = 'pending_binding_claimed_phone_ck' and contype = 'c';
  if not found then raise exception 'FAIL: pending_binding_claimed_phone_ck missing'; end if;
  perform 1 from pg_constraint where conname = 'pending_binding_claimed_name_ck' and contype = 'c';
  if not found then raise exception 'FAIL: pending_binding_claimed_name_ck missing'; end if;
  perform 1 from pg_constraint where conname = 'users_phone_format_ck' and contype = 'c';
  if not found then raise exception 'FAIL: users_phone_format_ck (canonical phone) missing'; end if;

  perform 1 from pg_proc where proname = 'capture_liff_binding_claim';
  if not found then raise exception 'FAIL: capture_liff_binding_claim function missing'; end if;
  if not has_function_privilege('service_role', 'capture_liff_binding_claim(text,text,text,timestamptz)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on capture_liff_binding_claim';
  end if;
  if not has_function_privilege('service_role', 'capture_pending_binding(text,text,text,timestamptz)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on capture_pending_binding';
  end if;
  -- Expected-superseded_count revision guard (0022; since 0025 the signature carries a
  -- trailing defaulted p_admin_id). The old 3-arg signature must be gone.
  if not has_function_privilege('service_role', 'approve_pending_binding(uuid,bigint,timestamptz,boolean,uuid)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on approve_pending_binding(revision-guarded)';
  end if;
  perform 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'approve_pending_binding' and p.pronargs = 3;
  if found then raise exception 'FAIL: stale 3-arg approve_pending_binding still present'; end if;

  raise notice 'PASS: liff binding claim columns/constraints + capture/approve RPC grants present';
end $$;

-- ── 28. member apply RPC + allocation claim lock protocol (Phase 7 Slice 3) ─
do $$
begin
  perform 1 from pg_proc where proname = 'apply_reservation';
  if not found then raise exception 'FAIL: apply_reservation function missing'; end if;
  if not has_function_privilege('service_role', 'apply_reservation(uuid,uuid,uuid,boolean,smallint,timestamptz)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on apply_reservation';
  end if;
  -- The allocator's half of the apply-window locking protocol.
  perform 1 from pg_proc where proname = 'claim_friday_allocation';
  if not found then raise exception 'FAIL: claim_friday_allocation function missing'; end if;
  if not has_function_privilege('service_role', 'claim_friday_allocation(uuid,text)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on claim_friday_allocation';
  end if;
  raise notice 'PASS: apply_reservation + claim_friday_allocation RPCs + grants present';
end $$;

-- ── 29. offer expiry guard: apply_offer_resolution carries p_expiry_guard ──
do $$
begin
  -- 8-arg signature (p_expiry_guard); the old 7-arg one must be gone.
  if not has_function_privilege('service_role',
    'apply_offer_resolution(uuid,uuid,text,timestamptz,jsonb,jsonb,jsonb,boolean)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on apply_offer_resolution(8-arg)';
  end if;
  perform 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'apply_offer_resolution' and p.pronargs = 7;
  if found then raise exception 'FAIL: stale 7-arg apply_offer_resolution still present'; end if;
  raise notice 'PASS: apply_offer_resolution expiry-guard signature present (old 7-arg gone)';
end $$;

-- ── 30. Admin accounts + sessions + binding decider audit (Phase 8 Slice 1) ─
do $$
begin
  -- admin_accounts: structure + constraints
  perform 1 from pg_class where relname = 'admin_accounts' and relkind = 'r';
  if not found then raise exception 'FAIL: admin_accounts table missing'; end if;
  perform 1 from pg_indexes where indexname = 'admin_accounts_username_key';
  if not found then raise exception 'FAIL: admin_accounts_username_key unique index missing'; end if;
  perform 1 from pg_constraint where conname = 'admin_accounts_username_ck' and contype = 'c';
  if not found then raise exception 'FAIL: admin_accounts_username_ck (lowercase+format) missing'; end if;
  perform 1 from pg_constraint where conname = 'admin_accounts_password_hash_ck' and contype = 'c';
  if not found then raise exception 'FAIL: admin_accounts_password_hash_ck (scrypt prefix) missing'; end if;
  perform 1 from pg_constraint where conname = 'admin_accounts_display_name_ck' and contype = 'c';
  if not found then raise exception 'FAIL: admin_accounts_display_name_ck missing'; end if;
  perform 1 from pg_class where relname = 'admin_accounts' and relrowsecurity;
  if not found then raise exception 'FAIL: admin_accounts RLS not enabled'; end if;
  if not has_table_privilege('service_role', 'admin_accounts', 'insert') then
    raise exception 'FAIL: service_role lacks insert on admin_accounts';
  end if;
  if has_table_privilege('anon', 'admin_accounts', 'select') then
    raise exception 'FAIL: anon must not read admin_accounts';
  end if;

  -- admin_sessions: hashed-token mirror of member_sessions
  perform 1 from pg_class where relname = 'admin_sessions' and relkind = 'r';
  if not found then raise exception 'FAIL: admin_sessions table missing'; end if;
  perform 1 from pg_indexes where indexname = 'admin_sessions_token_hash_key';
  if not found then raise exception 'FAIL: admin_sessions_token_hash_key unique index missing'; end if;
  perform 1 from pg_constraint
    where conname = 'admin_sessions_expiry_after_creation' and contype = 'c';
  if not found then raise exception 'FAIL: admin_sessions_expiry_after_creation check missing'; end if;
  perform 1 from pg_class where relname = 'admin_sessions' and relrowsecurity;
  if not found then raise exception 'FAIL: admin_sessions RLS not enabled'; end if;
  if not has_table_privilege('service_role', 'admin_sessions', 'insert') then
    raise exception 'FAIL: service_role lacks insert on admin_sessions';
  end if;
  if has_table_privilege('anon', 'admin_sessions', 'select') then
    raise exception 'FAIL: anon must not read admin_sessions';
  end if;

  -- lock-cycle failure counter
  if not has_function_privilege('service_role', 'apply_admin_login_failure(uuid,timestamptz,int,int)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on apply_admin_login_failure';
  end if;

  -- binding decider audit: column + reason length bound + re-signed RPCs
  perform 1 from information_schema.columns
    where table_name = 'pending_binding' and column_name = 'decided_by_admin_id';
  if not found then raise exception 'FAIL: pending_binding.decided_by_admin_id missing'; end if;
  perform 1 from pg_constraint where conname = 'pending_binding_rejected_reason_len_ck' and contype = 'c';
  if not found then raise exception 'FAIL: pending_binding_rejected_reason_len_ck missing'; end if;
  if not has_function_privilege('service_role', 'approve_pending_binding(uuid,bigint,timestamptz,boolean,uuid)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on approve_pending_binding(5-arg)';
  end if;
  perform 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'approve_pending_binding' and p.pronargs = 4;
  if found then raise exception 'FAIL: stale 4-arg approve_pending_binding still present'; end if;
  if not has_function_privilege('service_role', 'reject_pending_binding(uuid,text,timestamptz,uuid)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on reject_pending_binding(4-arg)';
  end if;
  perform 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'reject_pending_binding' and p.pronargs = 3;
  if found then raise exception 'FAIL: stale 3-arg reject_pending_binding still present'; end if;

  raise notice 'PASS: admin_accounts + admin_sessions + login-failure RPC + binding decider audit present';
end $$;

-- ── 31. Admin account management RPCs (Phase 8 Slice 3) ─────────────────────
do $$
begin
  -- Signature gained p_acting_session_id + p_request_id when 0030 made this the
  -- audited exemplar; assertion 34 pins the audit-specific properties.
  if not has_function_privilege('service_role', 'set_admin_disabled(uuid,uuid,uuid,boolean,timestamptz,uuid)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on set_admin_disabled';
  end if;
  -- Signature gained p_acting_session_id + p_request_id in 0035, when the success path
  -- became audited (assertion 39 pins the rest).
  if not has_function_privilege('service_role', 'reset_admin_password(uuid,uuid,uuid,text,uuid)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on reset_admin_password';
  end if;

  raise notice 'PASS: admin account management RPCs (set_admin_disabled, reset_admin_password) present';
end $$;

-- ── 32. Binding PII retention (Phase 8 Slice 7) ─────────────────────────────
do $$
declare
  v_def text;
begin
  -- claim-shape constraint must include the redacted-decided third arm
  select pg_get_constraintdef(oid) into v_def
    from pg_constraint
   where conname = 'pending_binding_claim_shape_ck' and contype = 'c';
  if v_def is null then
    raise exception 'FAIL: pending_binding_claim_shape_ck missing';
  end if;
  if v_def !~* 'status.*approved.*rejected' then
    raise exception 'FAIL: pending_binding_claim_shape_ck lacks the redacted-decided arm';
  end if;

  perform 1 from pg_indexes where indexname = 'pending_binding_pii_retention_idx';
  if not found then raise exception 'FAIL: pending_binding_pii_retention_idx missing'; end if;

  if not has_function_privilege('service_role', 'redact_decided_binding_pii(timestamptz,int,int,boolean)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on redact_decided_binding_pii';
  end if;
  if has_function_privilege('anon', 'redact_decided_binding_pii(timestamptz,int,int,boolean)', 'execute') then
    raise exception 'FAIL: anon must not execute redact_decided_binding_pii';
  end if;

  raise notice 'PASS: binding PII retention (constraint arm, partial index, RPC grants) present';
end $$;

-- ── 33. Pastoral resolution + staff-PIN issuance audit (Phase 8 Slice 8) ─────
do $$
begin
  perform 1 from information_schema.columns
    where table_name = 'pastoral_care_alerts' and column_name = 'resolved_by_admin_id';
  if not found then raise exception 'FAIL: pastoral_care_alerts.resolved_by_admin_id missing'; end if;
  perform 1 from information_schema.columns
    where table_name = 'pastoral_care_alerts' and column_name = 'counter_reset';
  if not found then raise exception 'FAIL: pastoral_care_alerts.counter_reset missing'; end if;
  perform 1 from pg_constraint where conname = 'pastoral_care_alerts_note_len_ck' and contype = 'c';
  if not found then raise exception 'FAIL: pastoral_care_alerts_note_len_ck missing'; end if;
  perform 1 from pg_constraint where conname = 'pastoral_care_alerts_resolution_shape_ck' and contype = 'c';
  if not found then raise exception 'FAIL: pastoral_care_alerts_resolution_shape_ck missing'; end if;

  perform 1 from information_schema.columns
    where table_name = 'staff_sessions' and column_name = 'created_by_admin_id';
  if not found then raise exception 'FAIL: staff_sessions.created_by_admin_id missing'; end if;

  if not has_function_privilege('service_role', 'resolve_pastoral_alert(uuid,uuid,text,boolean,timestamptz)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on resolve_pastoral_alert';
  end if;
  if has_function_privilege('anon', 'resolve_pastoral_alert(uuid,uuid,text,boolean,timestamptz)', 'execute') then
    raise exception 'FAIL: anon must not execute resolve_pastoral_alert';
  end if;

  raise notice 'PASS: pastoral resolution columns/constraints/RPC + staff-PIN admin audit present';
end $$;

-- ── 34. Audit substrate: append-only + unforgeable by the app (Wave 2A-1 / #15) ──
-- These assertions exist because every one of them is a guarantee something else
-- now depends on, and each could be silently undone by an ordinary-looking future
-- migration (a blanket re-grant, a `create or replace` that drops SECURITY DEFINER,
-- a helper made callable "just for testing").
do $$
declare
  v_helper_sig text :=
    'private.append_audit_log(audit_actor_type,uuid,uuid,text,text,text,uuid,uuid,uuid,audit_result,jsonb)';
  v_rpc_sig    text := 'set_admin_disabled(uuid,uuid,uuid,boolean,timestamptz,uuid)';
  v_priv       text;
begin
  -- The app principal may READ the log and nothing else. TRUNCATE is listed
  -- explicitly: it is not covered by DELETE and it never fires a row-level trigger.
  foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
    if has_table_privilege('service_role', 'audit_logs', v_priv) then
      raise exception 'FAIL: service_role must not hold % on audit_logs', v_priv;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'audit_logs', 'SELECT') then
    raise exception 'FAIL: service_role lacks SELECT on audit_logs';
  end if;

  -- The whole point of the private schema: the app cannot reach the writer, so it
  -- cannot forge a row even though it can call the RPCs that legitimately write one.
  if has_schema_privilege('service_role', 'private', 'usage') then
    raise exception 'FAIL: service_role must not hold USAGE on schema private';
  end if;
  foreach v_priv in array array['service_role', 'anon', 'authenticated', 'public'] loop
    if has_function_privilege(v_priv, v_helper_sig, 'execute') then
      raise exception 'FAIL: % must not execute private.append_audit_log', v_priv;
    end if;
  end loop;

  -- SECURITY DEFINER is what lets the audited RPC reach the writer. Its two hazards
  -- must stay closed: without search_path it is a privilege-escalation vector, and
  -- without the revoke it would be one reachable by anon through PostgREST.
  if not exists (select 1 from pg_proc where proname = 'set_admin_disabled' and prosecdef) then
    raise exception 'FAIL: set_admin_disabled must be SECURITY DEFINER to reach the audit writer';
  end if;
  if not exists (
    select 1 from pg_proc
     where proname = 'set_admin_disabled'
       and array_to_string(proconfig, ',') like '%search_path%'
  ) then
    raise exception 'FAIL: SECURITY DEFINER set_admin_disabled must pin search_path';
  end if;
  foreach v_priv in array array['anon', 'authenticated', 'public'] loop
    if has_function_privilege(v_priv, v_rpc_sig, 'execute') then
      raise exception 'FAIL: % must not execute set_admin_disabled', v_priv;
    end if;
  end loop;
  if not has_function_privilege('service_role', v_rpc_sig, 'execute') then
    raise exception 'FAIL: service_role lacks execute on set_admin_disabled';
  end if;

  -- Only the old 4-arg overload being gone keeps the PostgREST call unambiguous.
  if exists (
    select 1 from pg_proc
     where proname = 'set_admin_disabled'
       and pg_get_function_identity_arguments(oid) = 'uuid, uuid, boolean, timestamptz'
  ) then
    raise exception 'FAIL: the pre-audit set_admin_disabled overload still exists';
  end if;

  if not exists (select 1 from pg_constraint where conname = 'audit_logs_actor_shape_ck') then
    raise exception 'FAIL: audit_logs_actor_shape_ck missing';
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_name = 'audit_logs' and column_name = 'request_id' and is_nullable = 'YES'
  ) then
    raise exception 'FAIL: audit_logs.request_id must be NOT NULL';
  end if;

  raise notice 'PASS: audit substrate is append-only, app-unforgeable, and shape-constrained';
end $$;

-- ── 34b. The trigger layer holds even if the grants are undone ───────────────────
-- Layer 1 (the revoke above) is the primary control, so a naive test would pass
-- purely on "permission denied" and never reach the triggers. This grants DML back
-- to prove the second layer independently — which is the layer that survives a
-- future migration repeating 0004's blanket `grant ... on all tables`.
do $$
declare
  v_blocked int := 0;
begin
  grant insert, update, delete, truncate on audit_logs to service_role;
  set local role service_role;

  begin
    update audit_logs set action = 'tampered.row';
    raise exception 'FAIL: UPDATE on audit_logs was allowed once granted';
  exception when insufficient_privilege then v_blocked := v_blocked + 1;
  end;

  begin
    delete from audit_logs;
    raise exception 'FAIL: DELETE on audit_logs was allowed once granted';
  exception when insufficient_privilege then v_blocked := v_blocked + 1;
  end;

  reset role;
  if v_blocked <> 2 then
    raise exception 'FAIL: expected UPDATE and DELETE to be trigger-blocked, got %', v_blocked;
  end if;
  raise notice 'PASS: audit_logs triggers block mutation even when DML is granted';
end $$;

-- ── 35. Weekly capacity admin: folded admin_reserved + guards (Wave 2B-1 / #14A) ─
do $$
declare
  v_sig text := 'set_weekly_capacity(uuid,date,int,int,int,uuid,uuid,uuid)';
  v_priv text;
begin
  -- The fold is what lets the UI show ONE 「保留·停用」number honestly: with
  -- admin_reserved pinned to 0, the formula's term for it is provably inert, so the
  -- number the 幹事 edits is provably the whole story.
  if not exists (select 1 from pg_constraint where conname = 'weekly_events_admin_reserved_folded_ck') then
    raise exception 'FAIL: weekly_events_admin_reserved_folded_ck missing — admin_reserved could go non-zero and the UI preview would silently disagree with the allocator';
  end if;
  if exists (select 1 from weekly_events where admin_reserved <> 0) then
    raise exception 'FAIL: a weekly_events row has non-zero admin_reserved';
  end if;

  if not exists (select 1 from pg_constraint where conname = 'weekly_events_blocked_within_total_ck') then
    raise exception 'FAIL: weekly_events_blocked_within_total_ck missing — manual SQL could drive computeCapacity negative, which throws and would brick Friday allocation';
  end if;

  perform 1 from information_schema.columns
   where table_name = 'weekly_events' and column_name = 'capacity_version';
  if not found then raise exception 'FAIL: weekly_events.capacity_version missing'; end if;

  -- SECURITY DEFINER is what lets this reach private.append_audit_log; its two hazards
  -- must stay closed (same pins as assertion 34's exemplar).
  if not exists (select 1 from pg_proc where proname = 'set_weekly_capacity' and prosecdef) then
    raise exception 'FAIL: set_weekly_capacity must be SECURITY DEFINER to reach the audit writer';
  end if;
  if not exists (
    select 1 from pg_proc
     where proname = 'set_weekly_capacity'
       and array_to_string(proconfig, ',') like '%search_path%'
  ) then
    raise exception 'FAIL: SECURITY DEFINER set_weekly_capacity must pin search_path';
  end if;
  foreach v_priv in array array['anon', 'authenticated', 'public'] loop
    if has_function_privilege(v_priv, v_sig, 'execute') then
      raise exception 'FAIL: % must not execute set_weekly_capacity', v_priv;
    end if;
  end loop;
  if not has_function_privilege('service_role', v_sig, 'execute') then
    raise exception 'FAIL: service_role lacks execute on set_weekly_capacity';
  end if;

  raise notice 'PASS: weekly capacity admin — admin_reserved folded+pinned, guards present, RPC locked down';
end $$;

-- ── 35b. The capacity guard actually refuses (behavioural, not just present) ─────
-- Assertion 35 proves the plumbing exists; this proves it BITES. The temp_approved
-- case is the one worth pinning: a cancellation promotes a waiting row straight into
-- temp_approved (0006:26-36) and apply_offer_resolution later flips it to approved
-- with NO capacity check — so a guard counting only 'approved' would let capacity be
-- cut during a live offer window and oversubscribe on confirm.
do $$
declare
  v_event uuid := 'e0000000-0000-0000-0000-000000000001';
  v_admin uuid;
  v_res   jsonb;
begin
  -- A REAL admin row: since 0035 the audit writer resolves the actor's role in the
  -- business transaction and raises for an id it cannot find, so a seed-style
  -- placeholder uuid would abort the capacity write it is supposed to be probing.
  insert into admin_accounts (username, password_hash)
  values ('verify.capacity.probe', 'scrypt$00$00') returning id into v_admin;

  update reservations set status = 'approved', release_deadline_at = '2026-06-21T02:30:00Z'
   where weekly_event_id = v_event and user_id = 'a0000000-0000-0000-0000-000000000001';
  update reservations set status = 'temp_approved'
   where weekly_event_id = v_event and user_id = 'a0000000-0000-0000-0000-000000000002';
  -- promised = 2 (one approved + one temp_approved); approved alone would be 1.

  -- 23 - 21 blocked - 0 admin_reserved - 1 reserved staff = 1 effective < 2 promised
  v_res := set_weekly_capacity(v_event, '2026-06-21', 23, 21, 0,
                               v_admin, gen_random_uuid(), gen_random_uuid());
  if (v_res->>'reason') <> 'capacity_below_promised' then
    raise exception 'FAIL: cutting below promised was allowed (temp_approved not counted?): %', v_res;
  end if;

  -- 23 - 20 - 0 - 1 = 2 effective = 2 promised → exactly enough, allowed.
  v_res := set_weekly_capacity(v_event, '2026-06-21', 23, 20, 0,
                               v_admin, gen_random_uuid(), gen_random_uuid());
  if (v_res->>'ok') <> 'true' then
    raise exception 'FAIL: effective == promised should be allowed: %', v_res;
  end if;

  -- A finalized event is not editable — via an ALLOWLIST, so a future status is not
  -- silently editable either.
  update weekly_events set status = 'finalized' where id = v_event;
  v_res := set_weekly_capacity(v_event, '2026-06-21', 23, 19, 1,
                               v_admin, gen_random_uuid(), gen_random_uuid());
  if (v_res->>'reason') <> 'event_not_editable' then
    raise exception 'FAIL: finalized event was editable: %', v_res;
  end if;

  raise notice 'PASS: capacity guard refuses below-promised (temp_approved counted) and non-editable events';
end $$;

-- ── 36. P2 eligibility model: review_status authoritative, p2_eligible derived (2B-2a / #10) ─
do $$
begin
  -- The enum must keep a NEUTRAL state. If 'unreviewed' were ever dropped, the only
  -- landing spot for "no human decision on record" becomes 'revoked' — which would claim
  -- a 幹事 took something away that they never granted, and (with import's retained_revoked
  -- rule) would lock those members out of the roster's reach entirely.
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'p2_review_status' and e.enumlabel = 'unreviewed'
  ) then
    raise exception 'FAIL: p2_review_status is missing the neutral unreviewed state';
  end if;

  -- p2_eligible must be GENERATED. If it ever became writable again, a writer could set
  -- it independently of review_status and the two truths the #10 contract exists to
  -- collapse would be back — silently, because nothing would fail.
  if not exists (
    select 1 from pg_attribute
     where attrelid = 'user_eligibility'::regclass
       and attname = 'p2_eligible' and attgenerated = 's'
  ) then
    raise exception 'FAIL: user_eligibility.p2_eligible must be a STORED generated column';
  end if;

  -- ...and it must carry NO date term. A date here would bake in the WRITER's as-of date,
  -- and both readers (allocator: event Sunday / review queue: today) would inherit it.
  if exists (
    select 1 from pg_attrdef d
      join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     where d.adrelid = 'user_eligibility'::regclass
       and a.attname = 'p2_eligible'
       and (pg_get_expr(d.adbin, d.adrelid) ilike '%valid_from%'
         or pg_get_expr(d.adbin, d.adrelid) ilike '%valid_until%'
         or pg_get_expr(d.adbin, d.adrelid) ilike '%current_date%'
         or pg_get_expr(d.adbin, d.adrelid) ilike '%now()%')
  ) then
    raise exception 'FAIL: p2_eligible references a date — it must derive from review_status ALONE (see 0032)';
  end if;

  if not exists (select 1 from pg_constraint where conname = 'eligibility_window_ordered_ck') then
    raise exception 'FAIL: eligibility_window_ordered_ck missing — valid_from could exceed valid_until';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eligibility_child_birthdate_reason_ck') then
    raise exception 'FAIL: eligibility_child_birthdate_reason_ck missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'eligibility_reason_present') then
    raise exception 'FAIL: eligibility_reason_present was not rebuilt after the p2_eligible drop/re-add';
  end if;

  perform 1 from information_schema.columns
   where table_name = 'user_eligibility' and column_name = 'review_version';
  if not found then raise exception 'FAIL: user_eligibility.review_version missing (2B-2b optimistic lock)'; end if;

  -- reviewed_by must point at admin_accounts. Pointing at users(id) — the MEMBER table,
  -- as 0001 had it — makes the column unwritable by its own writer: reviewers are
  -- admin_accounts rows.
  if not exists (
    select 1 from pg_constraint
     where conname = 'user_eligibility_reviewed_by_fkey'
       and confrelid = 'admin_accounts'::regclass
  ) then
    raise exception 'FAIL: user_eligibility.reviewed_by must reference admin_accounts(id)';
  end if;

  raise notice 'PASS: P2 eligibility model — review_status authoritative, p2_eligible generated and date-free, window pinned';
end $$;

-- ── 36b. The derived column actually tracks review_status (behavioural) ──────────
do $$
declare
  v_user uuid;
  v_elig boolean;
begin
  insert into users (display_name) values ('verify-p2-model') returning id into v_user;
  insert into user_eligibility (user_id, review_status, p2_reason)
       values (v_user, 'approved', 'pregnancy');

  select p2_eligible into v_elig from user_eligibility where user_id = v_user;
  if v_elig is not true then raise exception 'FAIL: approved did not derive p2_eligible = true'; end if;

  update user_eligibility set review_status = 'revoked' where user_id = v_user;
  select p2_eligible into v_elig from user_eligibility where user_id = v_user;
  if v_elig is not false then raise exception 'FAIL: revoked did not derive p2_eligible = false'; end if;

  update user_eligibility set review_status = 'unreviewed', p2_reason = null where user_id = v_user;
  select p2_eligible into v_elig from user_eligibility where user_id = v_user;
  if v_elig is not false then raise exception 'FAIL: unreviewed did not derive p2_eligible = false'; end if;

  -- The write must be refused, not silently ignored: that refusal is what forced
  -- import_member's rewrite, and it is the only thing stopping a future writer from
  -- re-creating the dual truth.
  begin
    update user_eligibility set p2_eligible = true where user_id = v_user;
    raise exception 'FAIL: writing p2_eligible was ALLOWED — the generated column is not protecting the invariant';
  exception when others then
    if sqlstate = 'P0001' then raise; end if;   -- our own FAIL, not the expected rejection
  end;

  raise notice 'PASS: p2_eligible tracks review_status and rejects direct writes';
end $$;

-- ── 36c. A minor's DOB cannot be stored in an append-only audit row (2B-2a / #10) ─
do $$
declare
  v_stored uuid;
begin
  -- 0030's denylist is an EXACT key match, so it stops 'birthdate' and nothing near it.
  -- 0032 introduced p2_child_birthdate, making a birthdate-named metadata key a live
  -- possibility for the first time. audit_logs cannot be updated, deleted or truncated —
  -- so a DOB written here is permanent. This must fail closed forever.
  begin
    select private.append_audit_log('system', null, null, null, 'probe.verify', 'user_eligibility',
             null, null, gen_random_uuid(), 'success',
             '{"p2_child_birthdate_from":"2020-09-01"}'::jsonb)
      into v_stored;
    raise exception 'FAIL: a child birthdate was ACCEPTED into audit metadata (row %) — the sanitizer is not closed', v_stored;
  exception when others then
    if sqlstate = 'P0001' and sqlerrm like 'FAIL:%' then raise; end if;
  end;

  -- ...but presence must stay reportable, or the write RPC gets pushed toward a vaguer key
  -- that leaks more, not less.
  select private.append_audit_log('system', null, null, null, 'probe.verify', 'user_eligibility',
           null, null, gen_random_uuid(), 'success', '{"child_birthdate_present":true}'::jsonb)
    into v_stored;
  if v_stored is null then
    raise exception 'FAIL: a boolean presence flag was rejected — the sanitizer has become a keyword ban';
  end if;

  raise notice 'PASS: audit sanitizer refuses birthdate VALUES while allowing presence flags';
end $$;

-- ── 37. P2 write path: RPCs locked down, invariants enforced (2B-2b / #10) ──────
do $$
declare
  v_priv text;
  v_sig  text;
begin
  foreach v_sig in array array[
    'set_p2_eligibility(uuid,int,text,p2_reason,date,date,date,date,text,uuid,uuid,uuid)',
    'mark_p2_reviewed(uuid,int,date,uuid,uuid,uuid)'
  ] loop
    if not exists (select 1 from pg_proc where oid = to_regprocedure(v_sig) and prosecdef) then
      raise exception 'FAIL: % must be SECURITY DEFINER to reach the audit writer', v_sig;
    end if;
    if not exists (
      select 1 from pg_proc where oid = to_regprocedure(v_sig)
         and array_to_string(proconfig, ',') like '%search_path%'
    ) then
      raise exception 'FAIL: SECURITY DEFINER % must pin search_path', v_sig;
    end if;
    foreach v_priv in array array['anon', 'authenticated', 'public'] loop
      if has_function_privilege(v_priv, v_sig, 'execute') then
        raise exception 'FAIL: % must not execute %', v_priv, v_sig;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_sig, 'execute') then
      raise exception 'FAIL: service_role lacks execute on %', v_sig;
    end if;
  end loop;

  -- The governance boundary import_member checks. If reviewed_at/reviewed_by could drift
  -- apart, "has a human decided?" would have two different answers.
  if not exists (select 1 from pg_constraint where conname = 'eligibility_reviewed_pair_ck') then
    raise exception 'FAIL: eligibility_reviewed_pair_ck missing — reviewed_at/reviewed_by could diverge';
  end if;

  -- 「不可覛改」 is a DB guarantee, not a UI promise: this CHECK is the whole claim.
  if not exists (select 1 from pg_constraint where conname = 'eligibility_child_expiry_derived_ck') then
    raise exception 'FAIL: eligibility_child_expiry_derived_ck missing — a hand-set child expiry would be accepted';
  end if;
  if not exists (select 1 from pg_proc where proname = 'child_companion_valid_until' and provolatile = 'i') then
    raise exception 'FAIL: child_companion_valid_until must be IMMUTABLE or the CHECK cannot call it';
  end if;

  -- ⚠️ The DB session is UTC, so current_date is a UTC date: between 00:00-08:00 Taipei it is
  -- YESTERDAY, and the past-date guards would refuse a legitimate same-day review date for 8
  -- hours every day. This pins the fix so nobody "simplifies" it back.
  foreach v_sig in array array['set_p2_eligibility', 'mark_p2_reviewed'] loop
    if not exists (select 1 from pg_proc where proname = v_sig and prosrc like '%Asia/Taipei%') then
      raise exception 'FAIL: % lost its Asia/Taipei date computation (current_date is UTC here)', v_sig;
    end if;
    -- Strip `-- comments` before matching: both functions EXPLAIN why current_date is wrong,
    -- and a naive scan flags the explanation as the offence.
    if exists (
      select 1 from pg_proc
       where proname = v_sig
         and regexp_replace(prosrc, '--[^\n]*', '', 'g') ~ '\mcurrent_date\M'
    ) then
      raise exception 'FAIL: % uses current_date — that is a UTC date on this server', v_sig;
    end if;
  end loop;

  raise notice 'PASS: P2 write RPCs locked down, governance pair + derived expiry pinned, Taipei date computed in SQL';
end $$;

-- ── 37b. The write path actually bites (behavioural) ────────────────────────────
do $$
declare
  v_admin uuid;
  v_user  uuid;
  v_r     jsonb;
begin
  insert into admin_accounts (username, password_hash)
       values ('verify-p2-writer', 'scrypt$notarealhash') returning id into v_admin;
  insert into users (display_name) values ('verify-p2-target') returning id into v_user;

  -- The delivery blocker: a general member has NO eligibility row, and 幹事 must be able to
  -- approve them anyway. If this ever returns not_found, #10 has silently regressed to
  -- "edit-only" and the church is back to needing a CSV.
  v_r := set_p2_eligibility(v_user, 0, 'approved', 'pregnancy', null, '2099-01-01', null,
                            '2098-12-01', null, v_admin, gen_random_uuid(), gen_random_uuid());
  if not (v_r->>'ok')::boolean then
    raise exception 'FAIL: could not create eligibility for a member who had none (%)', v_r->>'reason';
  end if;
  if (select reviewed_at from user_eligibility where user_id = v_user) is null then
    raise exception 'FAIL: an approve did not set reviewed_at — import would overwrite it';
  end if;

  -- A revoked row must not be markable as reviewed, or the cleared review date comes back.
  v_r := set_p2_eligibility(v_user, 1, 'revoked', null, null, '2099-01-01', null, null, null,
                            v_admin, gen_random_uuid(), gen_random_uuid());
  if not (v_r->>'ok')::boolean then raise exception 'FAIL: revoke refused (%)', v_r->>'reason'; end if;
  if (select p2_review_date from user_eligibility where user_id = v_user) is not null then
    raise exception 'FAIL: revoke did not clear p2_review_date';
  end if;

  v_r := mark_p2_reviewed(v_user, 2, '2099-06-30', v_admin, gen_random_uuid(), gen_random_uuid());
  if v_r->>'reason' is distinct from 'eligibility_not_approved' then
    raise exception 'FAIL: mark_p2_reviewed accepted a non-approved row (%)', v_r;
  end if;

  raise notice 'PASS: P2 write path creates for a no-row member, governs on approve, and refuses to review a revoked row';
end $$;

-- ── 38. Audit retention purge: locked-down RPC + owner-equality (Wave 2A-3 / #15) ─
-- The purge is the only DELETE path into an append-only table, so its lockdown mirrors
-- append_audit_log's, plus one dependency unique to it: lock 2 in the trigger checks
-- current_user = the table owner, and a SECURITY DEFINER runs AS its own owner — so if
-- the fn's owner ever diverged from audit_logs' owner, even a LEGITIMATE purge would be
-- rejected forever. That equality is a correctness invariant, not just a nicety.
do $$
begin
  if not exists (select 1 from pg_proc where proname = 'purge_audit_logs' and prosecdef) then
    raise exception 'FAIL: purge_audit_logs must be SECURITY DEFINER';
  end if;
  if not exists (
    select 1 from pg_proc where proname = 'purge_audit_logs' and proconfig::text like '%search_path%'
  ) then
    raise exception 'FAIL: purge_audit_logs must pin search_path';
  end if;
  if not has_function_privilege('service_role', 'purge_audit_logs(int,int,boolean,uuid)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on purge_audit_logs';
  end if;
  if has_function_privilege('anon', 'purge_audit_logs(int,int,boolean,uuid)', 'execute')
     or has_function_privilege('authenticated', 'purge_audit_logs(int,int,boolean,uuid)', 'execute') then
    raise exception 'FAIL: anon/authenticated must not execute purge_audit_logs';
  end if;

  if (select proowner from pg_proc where proname = 'purge_audit_logs')
     is distinct from (select relowner from pg_class where oid = 'public.audit_logs'::regclass) then
    raise exception 'FAIL: purge_audit_logs owner <> audit_logs owner — lock 2 would reject even a legitimate purge';
  end if;

  if not exists (
    select 1 from pg_proc where proname = 'audit_logs_block_mutation' and prosrc like '%audit.allow_purge%'
  ) then
    raise exception 'FAIL: audit_logs_block_mutation lost the purge escape hatch (2A-3)';
  end if;

  perform 1 from pg_indexes where indexname = 'audit_logs_retention_idx';
  if not found then raise exception 'FAIL: audit_logs_retention_idx missing'; end if;

  raise notice 'PASS: purge_audit_logs is locked down, owner-matched, and the escape hatch is present';
end $$;

-- ── 38b. The escape hatch behaves: the purge deletes, but the seam does not leak ──
-- Mirrors 34b — grant DELETE back to service_role (simulating a future migration that
-- repeats 0004's blanket grant) so this exercises lock 2 (owner identity) INDEPENDENT
-- of the grant layer, and even with the GUC turned on.
do $$
declare
  v_id uuid;
begin
  insert into audit_logs (created_at, actor_type, action, entity_type, request_id, result, metadata_redacted)
    values (now() - interval '300 months', 'system', 'verify.purge_probe', 'audit',
            gen_random_uuid(), 'success', '{}')
    returning id into v_id;

  -- (a) service_role calling the fn deletes it — the granted path works.
  set local role service_role;
  perform purge_audit_logs(24, 500, false, gen_random_uuid());
  reset role;
  if exists (select 1 from audit_logs where id = v_id) then
    raise exception 'FAIL: purge_audit_logs did not delete an ancient row via service_role';
  end if;

  -- (b) but a DIRECT delete by service_role is blocked by lock 2, even with DELETE
  -- granted back AND the GUC set on — because current_user (service_role) <> owner.
  insert into audit_logs (created_at, actor_type, action, entity_type, request_id, result, metadata_redacted)
    values (now() - interval '300 months', 'system', 'verify.purge_probe2', 'audit',
            gen_random_uuid(), 'success', '{}')
    returning id into v_id;
  grant delete on audit_logs to service_role;
  set local role service_role;
  perform set_config('audit.allow_purge', 'on', true);
  begin
    delete from audit_logs where id = v_id;
    raise exception 'FAIL: service_role deleted directly with grant+GUC — lock 2 (owner) did not hold';
  exception when sqlstate '42501' then
    null; -- expected: the trigger raises because current_user is not the owner
  end;
  reset role;
  revoke delete on audit_logs from service_role;

  raise notice 'PASS: audit purge deletes via the fn, and the DELETE seam does not leak to the app principal';
end $$;

-- ── 39. Admin role tiers (Wave 2C-1 / #19) ──────────────────────────────────────
do $$
declare
  v_rpc_sig text := 'reset_admin_password(uuid,uuid,uuid,text,uuid)';
  v_priv    text;
  v_default text;
begin
  -- Exactly two values. A third (e.g. a read-only tier) added without wiring
  -- lib/adminRoles.ts's capability matrix would fail OPEN at every clerk-level check.
  if (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
       where t.typname = 'admin_role') <> 2 then
    raise exception 'FAIL: admin_role must have exactly the two implemented values';
  end if;
  perform 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'admin_role' and e.enumlabel = 'superadmin';
  if not found then raise exception 'FAIL: admin_role is missing superadmin'; end if;
  perform 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'admin_role' and e.enumlabel = 'clerk';
  if not found then raise exception 'FAIL: admin_role is missing clerk'; end if;

  -- default clerk: a future write path that forgets to name a role must land on the
  -- least-privileged side, never on superadmin.
  select column_default into v_default from information_schema.columns
    where table_name = 'admin_accounts' and column_name = 'role';
  if v_default is null or v_default not like '%clerk%' then
    raise exception 'FAIL: admin_accounts.role must default to clerk (got %)', coalesce(v_default, '<none>');
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_name = 'admin_accounts' and column_name = 'role' and is_nullable = 'YES'
  ) then
    raise exception 'FAIL: admin_accounts.role must be NOT NULL';
  end if;

  -- NOT VALID on purpose and FOREVER: pre-0035 admin rows have null snapshots because
  -- roles did not exist. Validating it would fail on that honest history — so the
  -- un-validated state is the assertion, not a leftover to be tidied up.
  if not exists (
    select 1 from pg_constraint
     where conname = 'audit_logs_admin_role_snapshot_ck' and contype = 'c'
  ) then
    raise exception 'FAIL: audit_logs_admin_role_snapshot_ck missing';
  end if;
  if (select convalidated from pg_constraint where conname = 'audit_logs_admin_role_snapshot_ck') then
    raise exception 'FAIL: audit_logs_admin_role_snapshot_ck was validated — pre-0035 rows are legitimately null';
  end if;

  -- reset_admin_password is now audited, so it is SECURITY DEFINER with the same two
  -- hazards closed as the other audited RPCs.
  if not exists (select 1 from pg_proc where proname = 'reset_admin_password' and prosecdef) then
    raise exception 'FAIL: reset_admin_password must be SECURITY DEFINER to reach the audit writer';
  end if;
  if not exists (
    select 1 from pg_proc
     where proname = 'reset_admin_password'
       and array_to_string(proconfig, ',') like '%search_path%'
  ) then
    raise exception 'FAIL: SECURITY DEFINER reset_admin_password must pin search_path';
  end if;
  foreach v_priv in array array['anon', 'authenticated', 'public'] loop
    if has_function_privilege(v_priv, v_rpc_sig, 'execute') then
      raise exception 'FAIL: % must not execute reset_admin_password', v_priv;
    end if;
  end loop;
  if exists (
    select 1 from pg_proc
     where proname = 'reset_admin_password'
       and pg_get_function_identity_arguments(oid) = 'uuid, uuid, text'
  ) then
    raise exception 'FAIL: the pre-audit 3-arg reset_admin_password overload still exists';
  end if;

  raise notice 'PASS: admin_role enum + column defaults + audited reset_admin_password are in place';
end $$;

-- ── 39b. The role snapshot is filled, and refuses to be guessed (behavioural) ────
-- Two halves of one rule: an admin row must carry the actor's role, and an admin
-- actor that cannot be resolved must take the business transaction down with it
-- rather than quietly writing an incomplete governance record.
do $$
declare
  v_admin uuid;
  v_id    uuid;
  v_role  text;
begin
  insert into admin_accounts (username, password_hash, role)
  values ('verify.role.probe', 'scrypt$00$00', 'clerk')
  returning id into v_admin;

  -- Caller passes null (the pre-2C RPCs' shape) → the writer resolves it in-transaction.
  select private.append_audit_log(
    'admin', v_admin, gen_random_uuid(), null,
    'probe.verify', 'admin_account', v_admin, null,
    gen_random_uuid(), 'success', '{}'::jsonb
  ) into v_id;
  select actor_role_snapshot into v_role from audit_logs where id = v_id;
  if v_role is distinct from 'clerk' then
    raise exception 'FAIL: append_audit_log did not resolve the admin role (got %)', coalesce(v_role, '<null>');
  end if;

  -- An admin actor pointing at no account is a threading bug, not a governance
  -- refusal — it must raise so the business change rolls back with it.
  begin
    perform private.append_audit_log(
      'admin', gen_random_uuid(), gen_random_uuid(), null,
      'probe.verify', 'admin_account', null, null,
      gen_random_uuid(), 'success', '{}'::jsonb
    );
    raise exception 'FAIL: append_audit_log wrote an admin row with an unresolvable role';
  exception when others then
    if sqlerrm not like '%no resolvable role%' then raise; end if;
  end;

  raise notice 'PASS: admin audit rows carry a role snapshot, and an unresolvable actor fails loud';
end $$;

-- ── 40. Admin role management RPCs (Wave 2C-2 / #19) ─────────────────────────────
-- Signatures (exact args + names, since PostgREST calls by name), SECURITY DEFINER +
-- search_path, and grants for the three account-management RPCs.
do $$
declare
  v_sig text;
  v_priv text;
  v_args text;
  v_writer_owner oid := (select proowner from pg_proc
    where oid = to_regprocedure('private.append_audit_log(audit_actor_type,uuid,uuid,text,text,text,uuid,uuid,uuid,audit_result,jsonb)'));
  -- Full argument lists WITH names: PostgREST invokes these by named argument (p_*), so a
  -- drift here breaks every call even though the type signature still matches.
  v_expected constant jsonb := jsonb_build_object(
    'create_admin_account(text,text,text,admin_role,uuid,uuid,uuid)',
      'p_username text, p_password_hash text, p_display_name text, p_role admin_role, p_acting_admin_id uuid, p_acting_session_id uuid, p_request_id uuid',
    'set_admin_role(uuid,uuid,uuid,admin_role,uuid)',
      'p_target_id uuid, p_acting_admin_id uuid, p_acting_session_id uuid, p_role admin_role, p_request_id uuid',
    'revoke_admin_sessions(uuid,uuid,uuid,uuid)',
      'p_target_id uuid, p_acting_admin_id uuid, p_acting_session_id uuid, p_request_id uuid'
  );
begin
  for v_sig in select jsonb_object_keys(v_expected) loop
    if to_regprocedure(v_sig) is null then
      raise exception 'FAIL: % missing (exact signature)', v_sig;
    end if;
    if not exists (select 1 from pg_proc where oid = to_regprocedure(v_sig) and prosecdef) then
      raise exception 'FAIL: % must be SECURITY DEFINER to reach the audit writer', v_sig;
    end if;
    if not exists (
      select 1 from pg_proc where oid = to_regprocedure(v_sig)
        and array_to_string(proconfig, ',') like '%search_path%'
    ) then
      raise exception 'FAIL: SECURITY DEFINER % must pin search_path', v_sig;
    end if;
    foreach v_priv in array array['anon', 'authenticated', 'public'] loop
      if has_function_privilege(v_priv, v_sig, 'execute') then
        raise exception 'FAIL: % must not execute %', v_priv, v_sig;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_sig, 'execute') then
      raise exception 'FAIL: service_role lacks execute on %', v_sig;
    end if;
    -- Argument names (the PostgREST contract).
    v_args := pg_get_function_arguments(to_regprocedure(v_sig));
    if v_args is distinct from (v_expected ->> v_sig) then
      raise exception 'FAIL: % argument names drifted — got "%"', v_sig, v_args;
    end if;
    -- Returns jsonb (the typed { ok, reason, ... } contract the service reads).
    if (select prorettype from pg_proc where oid = to_regprocedure(v_sig)) <> 'jsonb'::regtype then
      raise exception 'FAIL: % must return jsonb', v_sig;
    end if;
    -- Owner-equality with append_audit_log is load-bearing: a SECURITY DEFINER runs as
    -- its owner, and only the owner retains EXECUTE on the writer (granted to nobody).
    -- A differently-owned RPC could not write its audit row at all.
    if (select proowner from pg_proc where oid = to_regprocedure(v_sig)) <> v_writer_owner then
      raise exception 'FAIL: % owner <> append_audit_log owner — it could not reach the writer', v_sig;
    end if;
  end loop;

  raise notice 'PASS: role management RPCs — signatures, arg names, return type, owner, grants all pinned';
end $$;

-- ── 41. Member roster export audit RPC (Wave 3 3d / #5B-a) ───────────────────────
-- The audited, DB-authoritative gate for the roster CSV export (0037): exact signature +
-- arg names, SECURITY DEFINER + pinned search_path, owner-equality with the audit writer
-- (only the writer's owner may reach it), and service_role-only execute.
do $$
declare
  v_sig constant text := 'log_member_roster_export(uuid,uuid,uuid,integer)';
  v_expected_args constant text := 'p_acting_admin_id uuid, p_acting_session_id uuid, p_request_id uuid, p_row_count integer';
  v_writer_owner oid := (select proowner from pg_proc
    where oid = to_regprocedure('private.append_audit_log(audit_actor_type,uuid,uuid,text,text,text,uuid,uuid,uuid,audit_result,jsonb)'));
begin
  if to_regprocedure(v_sig) is null then
    raise exception 'FAIL: % missing (exact signature)', v_sig;
  end if;
  if not exists (select 1 from pg_proc where oid = to_regprocedure(v_sig) and prosecdef) then
    raise exception 'FAIL: % must be SECURITY DEFINER to reach the audit writer', v_sig;
  end if;
  if not exists (select 1 from pg_proc where oid = to_regprocedure(v_sig)
      and array_to_string(proconfig, ',') like '%search_path%') then
    raise exception 'FAIL: SECURITY DEFINER % must pin search_path', v_sig;
  end if;
  if has_function_privilege('anon', v_sig, 'execute')
     or has_function_privilege('authenticated', v_sig, 'execute')
     or has_function_privilege('public', v_sig, 'execute') then
    raise exception 'FAIL: % must be executable only by service_role', v_sig;
  end if;
  if not has_function_privilege('service_role', v_sig, 'execute') then
    raise exception 'FAIL: service_role lacks execute on %', v_sig;
  end if;
  if pg_get_function_arguments(to_regprocedure(v_sig)) is distinct from v_expected_args then
    raise exception 'FAIL: % argument names drifted', v_sig;
  end if;
  if (select prorettype from pg_proc where oid = to_regprocedure(v_sig)) <> 'jsonb'::regtype then
    raise exception 'FAIL: % must return jsonb', v_sig;
  end if;
  if (select proowner from pg_proc where oid = to_regprocedure(v_sig)) <> v_writer_owner then
    raise exception 'FAIL: % owner <> append_audit_log owner — it could not reach the writer', v_sig;
  end if;

  -- db_now() ships in the SAME migration (0037) and is a runtime dependency of the export:
  -- the service reads it for the membership cutoff before paging the roster. If it were
  -- missing or grant-drifted, the export route would 500 in prod even though the audit RPC
  -- above verified clean — so it must be pinned by the SAME contract, not left unchecked.
  if to_regprocedure('db_now()') is null then
    raise exception 'FAIL: db_now() missing — the export cutoff has no DB clock to read';
  end if;
  if (select prorettype from pg_proc where oid = to_regprocedure('db_now()')) <> 'timestamptz'::regtype then
    raise exception 'FAIL: db_now() must return timestamptz';
  end if;
  if has_function_privilege('anon', 'db_now()', 'execute')
     or has_function_privilege('authenticated', 'db_now()', 'execute')
     or has_function_privilege('public', 'db_now()', 'execute') then
    raise exception 'FAIL: db_now() must be executable only by service_role';
  end if;
  if not has_function_privilege('service_role', 'db_now()', 'execute') then
    raise exception 'FAIL: service_role lacks execute on db_now()';
  end if;

  raise notice 'PASS: member roster export audit RPC + db_now cutoff clock — signature, owner, search_path, grants pinned';
end $$;

-- ── 40b. The role RPCs actually behave (behavioural) ─────────────────────────────
-- no-op writes nothing; username collision is typed and unaudited; a role change writes
-- exactly one row with the actor's snapshot and the target's from/to; revoke writes even
-- for zero sessions; and the unique-violation handler does NOT swallow an audit failure.
do $$
declare
  sa uuid; sa2 uuid; target uuid; r jsonb; n int; before_rows int;
begin
  insert into admin_accounts (username, password_hash, role) values ('vrp-sa','scrypt$x$x','superadmin') returning id into sa;
  insert into admin_accounts (username, password_hash, role) values ('vrp-sa2','scrypt$x$x','superadmin') returning id into sa2;

  -- create a clerk
  r := create_admin_account('vrp-new','scrypt$x$x','某某','clerk', sa, gen_random_uuid(), gen_random_uuid());
  if not (r->>'ok')::bool then raise exception 'FAIL: create should succeed: %', r; end if;
  if r->>'username' <> 'vrp-new' then raise exception 'FAIL: create must return canonical username: %', r; end if;
  target := (r->>'id')::uuid;

  -- duplicate username → typed, and NO audit row
  select count(*) into before_rows from audit_logs where action = 'admin_account.create';
  r := create_admin_account('vrp-new','scrypt$x$x',null,'clerk', sa, gen_random_uuid(), gen_random_uuid());
  if r->>'reason' <> 'username_taken' then raise exception 'FAIL: dup username: %', r; end if;
  select count(*) into n from audit_logs where action = 'admin_account.create';
  if n <> before_rows then raise exception 'FAIL: username_taken must not write an audit row'; end if;

  -- audit failure (null request_id) must RAISE and roll back, not be swallowed as 409
  begin
    r := create_admin_account('vrp-auditfail','scrypt$x$x',null,'clerk', sa, gen_random_uuid(), null);
    raise exception 'FAIL: null request_id should have raised, got %', r;
  exception when not_null_violation then
    null; -- expected: the audit insert hit request_id NOT NULL
  end;
  if exists (select 1 from admin_accounts where username = 'vrp-auditfail') then
    raise exception 'FAIL: an audit failure must roll the account back too';
  end if;

  -- promote, then same-role no-op writes nothing
  r := set_admin_role(target, sa, gen_random_uuid(), 'superadmin', gen_random_uuid());
  if not ((r->>'ok')::bool and (r->>'changed')::bool) then raise exception 'FAIL: promote: %', r; end if;
  select count(*) into before_rows from audit_logs where action = 'admin_account.role_change';
  r := set_admin_role(target, sa, gen_random_uuid(), 'superadmin', gen_random_uuid());
  if not ((r->>'ok')::bool and not (r->>'changed')::bool) then raise exception 'FAIL: no-op: %', r; end if;
  select count(*) into n from audit_logs where action = 'admin_account.role_change';
  if n <> before_rows then raise exception 'FAIL: same-role no-op must not write an audit row'; end if;

  -- a real role change: one row, actor snapshot = acting role, from/to = target's change
  r := set_admin_role(target, sa, gen_random_uuid(), 'clerk', 'a1a1a1a1-1111-4111-8111-111111111111');
  if not (r->>'ok')::bool then raise exception 'FAIL: demote: %', r; end if;
  select count(*) into n from audit_logs
    where request_id = 'a1a1a1a1-1111-4111-8111-111111111111' and action = 'admin_account.role_change';
  if n <> 1 then raise exception 'FAIL: role change must write exactly one row, got %', n; end if;
  perform 1 from audit_logs
    where request_id = 'a1a1a1a1-1111-4111-8111-111111111111'
      and actor_role_snapshot = 'superadmin'
      and metadata_redacted = jsonb_build_object('from_role','superadmin','to_role','clerk');
  if not found then raise exception 'FAIL: role change snapshot/metadata wrong'; end if;

  -- self-target is audited (rule 7)
  r := set_admin_role(sa, sa, gen_random_uuid(), 'clerk', 'b2b2b2b2-2222-4222-8222-222222222222');
  if r->>'reason' <> 'cannot_target_self' then raise exception 'FAIL: self role change: %', r; end if;
  perform 1 from audit_logs
    where request_id = 'b2b2b2b2-2222-4222-8222-222222222222'
      and action = 'admin_account.role_change' and result = 'denied';
  if not found then raise exception 'FAIL: self-target must leave a denied row'; end if;

  -- revoke with zero sessions still writes a row
  r := revoke_admin_sessions(target, sa, gen_random_uuid(), 'c3c3c3c3-3333-4333-8333-333333333333');
  if not ((r->>'ok')::bool and (r->>'sessions_revoked')::int = 0) then raise exception 'FAIL: revoke zero: %', r; end if;
  perform 1 from audit_logs
    where request_id = 'c3c3c3c3-3333-4333-8333-333333333333'
      and action = 'admin_account.session_revoke' and result = 'success'
      and metadata_redacted = jsonb_build_object('sessions_revoked', 0);
  if not found then raise exception 'FAIL: revoke must write a row even for zero sessions'; end if;

  raise notice 'PASS: role management RPCs behave (no-op silent, dup typed, audit-fail rolls back, snapshots correct)';
end $$;

-- ── 42. Member maintenance: identity substrate (Tier 0-2 / 0038) ─────────────────
-- 0038's premise is that a member's identity is users.id and phone_number is a mutable
-- attribute. Three structures carry that premise, and each fails SILENTLY if it drifts:
--   * the name-match key must be computed by ONE function, or stored keys and live lookups
--     answer differently and the homonym guard stops catching anything;
--   * plate uniqueness must be ACTIVE-scoped, or a plate can never be re-issued;
--   * the claim-time snapshot must be reachable by the retention scan, or decided rows keep
--     a permanent pending_binding → member link that 0027's policy says they must not.
do $$
declare
  v_sig text;
  v_priv text;
  v_args text;
  v_gen char;
  v_expr text;
  v_writer_owner oid := (select proowner from pg_proc
    where oid = to_regprocedure('private.append_audit_log(audit_actor_type,uuid,uuid,text,text,text,uuid,uuid,uuid,audit_result,jsonb)'));
  -- Argument lists WITH names: PostgREST invokes by named argument, so a rename breaks
  -- every call while the type signature still matches.
  v_expected constant jsonb := jsonb_build_object(
    'create_member(text,text,uuid,uuid,uuid,uuid[])',
      'p_display_name text, p_phone text, p_acting_admin_id uuid, p_acting_session_id uuid, p_request_id uuid, p_confirmed_candidate_ids uuid[] DEFAULT NULL::uuid[]',
    'update_member_identity(uuid,text,text,uuid,uuid,uuid,timestamptz)',
      'p_user_id uuid, p_display_name text, p_phone text, p_acting_admin_id uuid, p_acting_session_id uuid, p_request_id uuid, p_now timestamp with time zone',
    'add_member_vehicle(uuid,text,uuid,uuid,uuid)',
      'p_user_id uuid, p_license_plate text, p_acting_admin_id uuid, p_acting_session_id uuid, p_request_id uuid',
    'set_member_vehicle_active(uuid,boolean,uuid,uuid,uuid)',
      'p_vehicle_id uuid, p_is_active boolean, p_acting_admin_id uuid, p_acting_session_id uuid, p_request_id uuid'
  );
begin
  -- (a) The name-match function is the single authority, and IMMUTABLE is load-bearing:
  -- a generated column may only call an immutable function, so a volatility downgrade does
  -- not merely "change a property" — it makes the column undefinable, and any attempt to
  -- work around it by recomputing in the RPCs would let stored keys and live lookups drift.
  if to_regprocedure('normalize_member_name_for_match(text)') is null then
    raise exception 'FAIL: normalize_member_name_for_match(text) missing';
  end if;
  if (select provolatile from pg_proc where oid = to_regprocedure('normalize_member_name_for_match(text)')) <> 'i' then
    raise exception 'FAIL: normalize_member_name_for_match must be IMMUTABLE (the generated column requires it)';
  end if;
  if (select prorettype from pg_proc where oid = to_regprocedure('normalize_member_name_for_match(text)')) <> 'text'::regtype then
    raise exception 'FAIL: normalize_member_name_for_match must return text';
  end if;
  if not exists (select 1 from pg_proc where oid = to_regprocedure('normalize_member_name_for_match(text)')
      and array_to_string(proconfig, ',') like '%search_path%') then
    raise exception 'FAIL: normalize_member_name_for_match must pin search_path';
  end if;

  -- (b) users.member_name_match_key is STORED-generated THROUGH that function. A plain
  -- column (or an inlined expression) would be the drift the function exists to prevent.
  select a.attgenerated, pg_get_expr(d.adbin, d.adrelid)
    into v_gen, v_expr
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'users'::regclass and a.attname = 'member_name_match_key';
  if v_gen is null then
    raise exception 'FAIL: users.member_name_match_key missing';
  end if;
  if v_gen <> 's' then
    raise exception 'FAIL: users.member_name_match_key must be a STORED generated column';
  end if;
  if v_expr is null or v_expr not like '%normalize_member_name_for_match%' then
    raise exception 'FAIL: member_name_match_key must be generated by normalize_member_name_for_match, got "%"', v_expr;
  end if;
  -- Deliberately NOT unique: the key is a candidate detector, and homonyms are legal.
  if exists (select 1 from pg_index
      where indrelid = 'users'::regclass and indisunique
        and pg_get_indexdef(indexrelid) like '%member_name_match_key%') then
    raise exception 'FAIL: member_name_match_key must NOT be unique — homonyms are legal members';
  end if;
  if not exists (select 1 from pg_index
      where indrelid = 'users'::regclass
        and pg_get_indexdef(indexrelid) like '%member_name_match_key%') then
    raise exception 'FAIL: member_name_match_key needs an index — every create/import looks up by it';
  end if;

  -- (c) The claim-time identity snapshot, and its FK.
  if not exists (select 1 from pg_attribute
      where attrelid = 'pending_binding'::regclass and attname = 'matched_user_id_at_capture'
        and atttypid = 'uuid'::regtype and not attisdropped) then
    raise exception 'FAIL: pending_binding.matched_user_id_at_capture missing (or not uuid)';
  end if;
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'pending_binding'::regclass and contype = 'f'
       and confrelid = 'users'::regclass
       and conkey = array[(select attnum from pg_attribute
                            where attrelid = 'pending_binding'::regclass
                              and attname = 'matched_user_id_at_capture')]
  ) then
    raise exception 'FAIL: matched_user_id_at_capture must reference users(id)';
  end if;

  -- (d) The retention scan predicate and its index must agree. If the index predicate omits
  -- the snapshot, a row whose three text columns were already cleared still matches the
  -- SCAN but not the INDEX — the daily job silently drops to a seq scan and, worse, the
  -- narrower predicate is the one an author is tempted to "fix" by narrowing the scan too.
  select pg_get_expr(indpred, indrelid) into v_expr from pg_index
   where indexrelid = 'pending_binding_pii_retention_idx'::regclass;
  if v_expr is null or v_expr not like '%matched_user_id_at_capture%' then
    raise exception 'FAIL: retention index predicate must include matched_user_id_at_capture, got "%"', v_expr;
  end if;

  -- (e) Plate uniqueness is ACTIVE-scoped, and the old global unique index is GONE. The
  -- absence is the assertion that matters: with it still present, deactivation would be
  -- pointless — a sold car's plate could never be issued to its new owner.
  if not exists (
    select 1 from pg_index
     where indexrelid = 'vehicles_active_plate_uq'::regclass
       and indisunique and pg_get_expr(indpred, indrelid) = 'is_active'
  ) then
    raise exception 'FAIL: vehicles_active_plate_uq must be a UNIQUE index partial on is_active';
  end if;
  if exists (
    select 1 from pg_index
     where indrelid = 'vehicles'::regclass and indisunique and indpred is null
       and pg_get_indexdef(indexrelid) like '%license_plate_normalized%'
  ) then
    raise exception 'FAIL: an UNCONDITIONAL unique index on license_plate_normalized still exists — plates could never be re-issued';
  end if;

  -- (f) The four maintenance RPCs: same lockdown contract as §40/§41.
  for v_sig in select jsonb_object_keys(v_expected) loop
    if to_regprocedure(v_sig) is null then
      raise exception 'FAIL: % missing (exact signature)', v_sig;
    end if;
    if not exists (select 1 from pg_proc where oid = to_regprocedure(v_sig) and prosecdef) then
      raise exception 'FAIL: % must be SECURITY DEFINER to reach the audit writer', v_sig;
    end if;
    if not exists (select 1 from pg_proc where oid = to_regprocedure(v_sig)
        and array_to_string(proconfig, ',') like '%search_path%') then
      raise exception 'FAIL: SECURITY DEFINER % must pin search_path', v_sig;
    end if;
    foreach v_priv in array array['anon', 'authenticated', 'public'] loop
      if has_function_privilege(v_priv, v_sig, 'execute') then
        raise exception 'FAIL: % must not execute %', v_priv, v_sig;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_sig, 'execute') then
      raise exception 'FAIL: service_role lacks execute on %', v_sig;
    end if;
    v_args := pg_get_function_arguments(to_regprocedure(v_sig));
    if v_args is distinct from (v_expected ->> v_sig) then
      raise exception 'FAIL: % argument names drifted — got "%"', v_sig, v_args;
    end if;
    if (select prorettype from pg_proc where oid = to_regprocedure(v_sig)) <> 'jsonb'::regtype then
      raise exception 'FAIL: % must return jsonb (the typed { ok, reason } contract)', v_sig;
    end if;
    if (select proowner from pg_proc where oid = to_regprocedure(v_sig)) <> v_writer_owner then
      raise exception 'FAIL: % owner <> append_audit_log owner — it could not reach the writer', v_sig;
    end if;
  end loop;

  raise notice 'PASS: member maintenance substrate — name-match authority, snapshot + retention, active-plate uniqueness, 4 RPCs pinned';
end $$;

-- ── 42b. The name key and the claim shape actually bite (behavioural) ────────────
do $$
declare
  v_a uuid; v_b uuid; v_key text;
begin
  -- Folding: case, ASCII space/tab, NBSP (U+00A0) and IDEOGRAPHIC SPACE (U+3000) all vanish.
  -- These are the invisible characters a pasted roster actually carries.
  if normalize_member_name_for_match('  John' || chr(9) || 'DOE ') <> 'johndoe' then
    raise exception 'FAIL: name key must fold case and ASCII whitespace';
  end if;
  if normalize_member_name_for_match('王' || chr(160) || '小明') <> normalize_member_name_for_match('王小明')
     or normalize_member_name_for_match('王' || chr(12288) || '小明') <> normalize_member_name_for_match('王小明') then
    raise exception 'FAIL: name key must fold NBSP and U+3000 — an invisible space would split one person into two';
  end if;

  -- The column tracks a RENAME. A key computed once at insert would leave the renamed
  -- member permanently findable under the old name and invisible under the new one.
  insert into users (display_name) values ('vmm 名字A') returning id into v_a;
  select member_name_match_key into v_key from users where id = v_a;
  if v_key <> 'vmm名字a' then
    raise exception 'FAIL: generated key wrong on insert: "%"', v_key;
  end if;
  update users set display_name = 'VMM 名字B' where id = v_a;
  select member_name_match_key into v_key from users where id = v_a;
  if v_key <> 'vmm名字b' then
    raise exception 'FAIL: generated key did not follow the rename: "%"', v_key;
  end if;

  -- Homonyms are legal: two members may share a key. (If this ever raises, the candidate
  -- mechanism has been turned into an identity by accident.)
  insert into users (display_name) values ('VMM 名字B') returning id into v_b;

  -- Claim shape: the snapshot belongs to the liff arm only.
  begin
    insert into pending_binding (line_user_id, submitted_code, claim_source, last_event_type,
                                 matched_user_id_at_capture)
      values ('vmm-line-shape', 'ABC123', 'keyword', 'message', v_a);
    raise exception 'FAIL: a keyword claim must not carry an identity snapshot';
  exception when check_violation then null;
  end;
  -- The third arm is the REDACTED shape (0027 clears a decided row's claim data after 90
  -- days). Once the text columns are gone the snapshot must be gone too, or the row keeps a
  -- permanent pending_binding → member link that retention was supposed to remove.
  begin
    insert into pending_binding (line_user_id, claim_source, last_event_type, status,
                                 approved_at, approved_user_id, matched_user_id_at_capture)
      values ('vmm-line-shape2', 'liff', 'liff', 'approved', now(), v_a, v_a);
    raise exception 'FAIL: a redacted claim must not keep an identity snapshot';
  exception when check_violation then null;
  end;

  raise notice 'PASS: name key folds invisible whitespace, follows renames, allows homonyms; snapshot obeys the claim shape';
end $$;

-- ── 42c. create_member: the homonym gate is a SET decision (behavioural) ─────────
-- "I confirm this is not A" must not silently mean "…and not B". The confirmation is
-- compared as a set, and a set that has moved since the operator looked is a CONFLICT —
-- audited, because it means someone else changed the roster mid-decision.
do $$
declare
  sa uuid; v_a uuid; r jsonb; n int; before_rows int;
begin
  insert into admin_accounts (username, password_hash, role)
    values ('vmm-sa', 'scrypt$x$x', 'superadmin') returning id into sa;

  -- No homonym → straight through, audited success, candidate_count 0.
  r := create_member('vmm唯一', '0977000001', sa, gen_random_uuid(),
                     'd1d1d1d1-1111-4111-8111-111111111111');
  if not (r->>'ok')::bool then raise exception 'FAIL: unique name should create: %', r; end if;
  perform 1 from audit_logs
   where request_id = 'd1d1d1d1-1111-4111-8111-111111111111'
     and action = 'member.create' and result = 'success'
     and entity_id = (r->>'user_id')::uuid
     and metadata_redacted = jsonb_build_object('homonym_confirmed', false, 'candidate_count', 0);
  if not found then raise exception 'FAIL: create must audit the entity and the confirmation shape'; end if;
  v_a := (r->>'user_id')::uuid;

  -- Same name again, no confirmation → step one of a flow, NOT a refusal: candidates are
  -- returned and NOTHING is audited (auditing every preview would flood the log).
  select count(*) into before_rows from audit_logs where action = 'member.create';
  r := create_member('vmm 唯一', '0977000002', sa, gen_random_uuid(), gen_random_uuid());
  if r->>'reason' <> 'homonym_requires_confirmation' then
    raise exception 'FAIL: homonym must be gated (note: whitespace-insensitively): %', r;
  end if;
  if jsonb_array_length(r->'candidates') <> 1
     or (r->'candidates'->0->>'id')::uuid <> v_a
     or r->'candidates'->0->>'evidence' <> 'same_name' then
    raise exception 'FAIL: candidates payload wrong: %', r;
  end if;
  select count(*) into n from audit_logs where action = 'member.create';
  if n <> before_rows then raise exception 'FAIL: a confirmation prompt must not write an audit row'; end if;

  -- A confirmation that does not match the CURRENT set → conflict, and audited.
  r := create_member('vmm 唯一', '0977000002', sa, gen_random_uuid(),
                     'd2d2d2d2-2222-4222-8222-222222222222', '{}'::uuid[]);
  if r->>'reason' <> 'homonym_confirmation_stale' then
    raise exception 'FAIL: an empty confirmation of a non-empty set must be stale: %', r;
  end if;
  perform 1 from audit_logs
   where request_id = 'd2d2d2d2-2222-4222-8222-222222222222'
     and action = 'member.create' and result = 'conflict';
  if not found then raise exception 'FAIL: a stale confirmation must be audited as a conflict'; end if;
  if exists (select 1 from users where phone_number = '0977000002') then
    raise exception 'FAIL: a stale confirmation must write nothing';
  end if;

  -- The right set → a second member with the same name is created deliberately.
  r := create_member('vmm 唯一', '0977000002', sa, gen_random_uuid(),
                     'd3d3d3d3-3333-4333-8333-333333333333', array[v_a]);
  if not (r->>'ok')::bool then raise exception 'FAIL: confirmed homonym should create: %', r; end if;
  perform 1 from audit_logs
   where request_id = 'd3d3d3d3-3333-4333-8333-333333333333'
     and action = 'member.create' and result = 'success'
     and metadata_redacted = jsonb_build_object('homonym_confirmed', true, 'candidate_count', 1);
  if not found then raise exception 'FAIL: a confirmed create must record that it was confirmed'; end if;

  -- Identity uniqueness refusing is a DENIAL, and the unique index — not the SELECT — is
  -- what has to catch it.
  r := create_member('vmm別的名字', '0977000001', sa, gen_random_uuid(),
                     'd4d4d4d4-4444-4444-8444-444444444444');
  if r->>'reason' <> 'phone_in_use' then raise exception 'FAIL: duplicate phone: %', r; end if;
  perform 1 from audit_logs
   where request_id = 'd4d4d4d4-4444-4444-8444-444444444444'
     and action = 'member.create' and result = 'denied'
     and metadata_redacted = jsonb_build_object('reason', 'phone_in_use');
  if not found then raise exception 'FAIL: phone_in_use must be audited as denied'; end if;

  -- Bad requests are typed and unaudited (a name of only invisible characters is not a name).
  select count(*) into before_rows from audit_logs where action = 'member.create';
  if (create_member(chr(12288) || ' ', '0977000003', sa, gen_random_uuid(), gen_random_uuid()))->>'reason'
       <> 'invalid_name' then
    raise exception 'FAIL: a whitespace-only name must be invalid_name';
  end if;
  if (create_member('vmm電話', '0912-345-678', sa, gen_random_uuid(), gen_random_uuid()))->>'reason'
       <> 'invalid_phone' then
    raise exception 'FAIL: a non-09xxxxxxxx phone must be invalid_phone';
  end if;
  select count(*) into n from audit_logs where action = 'member.create';
  if n <> before_rows then raise exception 'FAIL: bad requests must not be audited'; end if;

  raise notice 'PASS: create_member gates homonyms as a set, audits conflict/denied, and refuses bad input silently';
end $$;

-- ── 42d. Identity is users.id, and a phone change cannot retarget a claim ────────
-- The exact sequence 0038 exists to prevent, run end to end: A's phone is freed, A's LINE
-- re-submits the OLD phone, a NEW member is created holding it, and the admin approves.
-- Before the capture-time snapshot, that approval bound A's LINE account to member B.
do $$
declare
  sa uuid; a uuid; b uuid; p uuid; r jsonb; n int; before_rows int;
begin
  select id into sa from admin_accounts where username = 'vmm-sa';
  r := create_member('vmm會友A', '0977100001', sa, gen_random_uuid(), gen_random_uuid());
  a := (r->>'user_id')::uuid;

  -- A's LINE submits A's phone → the claim is resolved and FROZEN at capture.
  perform capture_liff_binding_claim('vmm-line-A', '0977100001', 'vmm會友A', now());
  -- Every lookup below is scoped to the PENDING row: a decided claim stays in the table
  -- (that is the point of the audit trail), so `where line_user_id = …` alone would be
  -- ambiguous the moment the first claim is rejected.
  select id, matched_user_id_at_capture into p, b
    from pending_binding where line_user_id = 'vmm-line-A' and status = 'pending';
  if b is distinct from a then raise exception 'FAIL: capture must snapshot the matched member'; end if;

  -- A keyword claim superseding it must CLEAR the snapshot (the XOR of 0022, extended).
  perform capture_pending_binding('vmm-line-A', 'ZZZ999', 'message', now());
  select matched_user_id_at_capture into b
    from pending_binding where line_user_id = 'vmm-line-A' and status = 'pending';
  if b is not null then raise exception 'FAIL: a keyword claim must clear the liff snapshot'; end if;
  perform capture_liff_binding_claim('vmm-line-A', '0977100001', 'vmm會友A', now());

  -- The admin changes A's phone. The outstanding claim is invalidated — joined by the
  -- SNAPSHOT, not by the phone, because the snapshot is what approval would have acted on.
  r := update_member_identity(a, 'vmm會友A', '0977100002', sa, gen_random_uuid(),
                              'e1e1e1e1-1111-4111-8111-111111111111', now());
  if not (r->>'ok')::bool or (r->>'bindings_invalidated')::int <> 1 then
    raise exception 'FAIL: a phone change must invalidate the outstanding claim: %', r;
  end if;
  perform 1 from pending_binding
   where id = p and status = 'rejected' and rejected_reason = 'phone_changed_by_admin'
     and rejected_at is not null and decided_by_admin_id = sa;
  -- rejected_at is not decoration: the retention scan keys on coalesce(approved_at,
  -- rejected_at), and a NULL there would keep this row's claim PII forever.
  if not found then raise exception 'FAIL: invalidated claim must be fully decided (incl. rejected_at)'; end if;
  perform 1 from audit_logs
   where request_id = 'e1e1e1e1-1111-4111-8111-111111111111'
     and action = 'member.identity_change' and result = 'success' and entity_id = a
     and metadata_redacted = jsonb_build_object('name_changed', false, 'phone_changed', true,
                                                'bindings_invalidated', 1);
  if not found then raise exception 'FAIL: identity change audit metadata wrong'; end if;

  -- Now the dangerous part: A's LINE re-submits the OLD phone, which is free again…
  perform capture_liff_binding_claim('vmm-line-A', '0977100001', 'vmm會友A', now());
  select id, matched_user_id_at_capture into p, b
    from pending_binding where line_user_id = 'vmm-line-A' and status = 'pending';
  if b is not null then raise exception 'FAIL: a claim matching nobody must snapshot NULL'; end if;

  -- …and a NEW member is created holding that phone.
  r := create_member('vmm會友B', '0977100001', sa, gen_random_uuid(), gen_random_uuid(), '{}'::uuid[]);
  b := (r->>'user_id')::uuid;
  if b is null then raise exception 'FAIL: the freed phone should be reusable: %', r; end if;

  -- Approval must refuse. Re-resolving claimed_phone here would bind A's LINE account to B.
  r := approve_pending_binding(p, (select superseded_count from pending_binding where id = p),
                               now(), false, sa);
  if r->>'reason' <> 'unmatched_at_capture' then
    raise exception 'FAIL: approval must use the capture-time snapshot, not the phone — got %', r;
  end if;
  if exists (select 1 from users where id = b and line_id is not null) then
    raise exception 'FAIL: CROSS-IDENTITY BINDING — a LINE account was bound to the wrong member';
  end if;

  -- A no-op identity write is inert: no audit row, and it reports changed=false.
  select count(*) into before_rows from audit_logs where action = 'member.identity_change';
  r := update_member_identity(a, 'vmm會友A', '0977100002', sa, gen_random_uuid(),
                              gen_random_uuid(), now());
  if not (r->>'ok')::bool or (r->>'changed')::bool then
    raise exception 'FAIL: an unchanged identity must report changed=false: %', r;
  end if;
  select count(*) into n from audit_logs where action = 'member.identity_change';
  if n <> before_rows then raise exception 'FAIL: a no-op identity write must not be audited'; end if;

  -- Taking another member's phone is a denial, not a 23505 reaching the caller.
  r := update_member_identity(a, 'vmm會友A', '0977100001', sa, gen_random_uuid(),
                              'e2e2e2e2-2222-4222-8222-222222222222', now());
  if r->>'reason' <> 'phone_in_use' then raise exception 'FAIL: phone takeover: %', r; end if;
  perform 1 from audit_logs
   where request_id = 'e2e2e2e2-2222-4222-8222-222222222222'
     and action = 'member.identity_change' and result = 'denied';
  if not found then raise exception 'FAIL: phone_in_use on rename must be audited as denied'; end if;

  raise notice 'PASS: identity is users.id — capture freezes the match, a phone change invalidates claims, and approval cannot be retargeted';
end $$;

-- ── 42e. Vehicle lifecycle: a plate is re-issuable, history is not rewritten ─────
do $$
declare
  sa uuid; a uuid; b uuid; v1 uuid; v2 uuid; r jsonb; ev uuid; res uuid; n int; before_rows int;
begin
  select id into sa from admin_accounts where username = 'vmm-sa';
  a := (create_member('vmm車主A', '0977200001', sa, gen_random_uuid(), gen_random_uuid()))->>'user_id';
  b := (create_member('vmm車主B', '0977200002', sa, gen_random_uuid(), gen_random_uuid()))->>'user_id';

  r := add_member_vehicle(a, 'vmm-8888', sa, gen_random_uuid(), 'f1f1f1f1-1111-4111-8111-111111111111');
  if not (r->>'ok')::bool then raise exception 'FAIL: first add should succeed: %', r; end if;
  v1 := (r->>'vehicle_id')::uuid;
  perform 1 from audit_logs
   where request_id = 'f1f1f1f1-1111-4111-8111-111111111111'
     and action = 'vehicle.add' and result = 'success' and entity_id = v1;
  if not found then raise exception 'FAIL: vehicle.add must audit the created vehicle'; end if;

  -- Adding the same plate to its own owner is inert guidance, not a denial: no audit row.
  select count(*) into before_rows from audit_logs where action = 'vehicle.add';
  if (add_member_vehicle(a, 'VMM8888', sa, gen_random_uuid(), gen_random_uuid()))->>'reason'
       <> 'active_plate_owned_by_self' then
    raise exception 'FAIL: re-adding your own active plate must be typed as owned_by_self';
  end if;
  select count(*) into n from audit_logs where action = 'vehicle.add';
  if n <> before_rows then raise exception 'FAIL: owned_by_self is inert and must not be audited'; end if;

  -- Another member cannot take an ACTIVE plate. That IS a refusal, so it is audited.
  r := add_member_vehicle(b, 'vmm 8888', sa, gen_random_uuid(), 'f2f2f2f2-2222-4222-8222-222222222222');
  if r->>'reason' <> 'active_plate_owned_by_other' then raise exception 'FAIL: plate takeover: %', r; end if;
  perform 1 from audit_logs
   where request_id = 'f2f2f2f2-2222-4222-8222-222222222222'
     and action = 'vehicle.add' and result = 'denied';
  if not found then raise exception 'FAIL: taking an active plate must be audited as denied'; end if;

  -- Deactivation is refused while an unfinished reservation references the car — checked
  -- in-transaction, because a disabled button is not a guard.
  insert into weekly_events (sunday_date) values ('2099-11-01') returning id into ev;
  insert into reservations (weekly_event_id, user_id, vehicle_id, effective_priority, status)
    values (ev, a, v1, 3, 'pending') returning id into res;
  r := set_member_vehicle_active(v1, false, sa, gen_random_uuid(),
                                 'f3f3f3f3-3333-4333-8333-333333333333');
  if r->>'reason' <> 'unfinished_reservations' or (r->>'unfinished')::int <> 1 then
    raise exception 'FAIL: deactivation must refuse while a reservation is unfinished: %', r;
  end if;
  perform 1 from audit_logs
   where request_id = 'f3f3f3f3-3333-4333-8333-333333333333'
     and action = 'vehicle.deactivate' and result = 'denied';
  if not found then raise exception 'FAIL: refused deactivation must be audited'; end if;

  -- A TERMINAL reservation is no obstacle (the car's week is over).
  update reservations set status = 'cancelled_by_user', cancelled_at = now() where id = res;
  r := set_member_vehicle_active(v1, false, sa, gen_random_uuid(), gen_random_uuid());
  if not (r->>'ok')::bool or (r->>'is_active')::bool then
    raise exception 'FAIL: deactivation should succeed once nothing is unfinished: %', r;
  end if;
  if (set_member_vehicle_active(v1, false, sa, gen_random_uuid(), gen_random_uuid()))->>'reason'
       <> 'already_inactive' then
    raise exception 'FAIL: a second deactivation must be typed as already_inactive';
  end if;

  -- The point of all of it: the plate is now re-issuable to its new owner, and A's row
  -- SURVIVES. Rewriting the old row's owner would falsify every reservation that
  -- references (vehicle_id, user_id) — i.e. that car AND who drove it at the time.
  r := add_member_vehicle(b, 'VMM-8888', sa, gen_random_uuid(), gen_random_uuid());
  if not (r->>'ok')::bool then raise exception 'FAIL: an inactive plate must be re-issuable: %', r; end if;
  v2 := (r->>'vehicle_id')::uuid;
  if not exists (select 1 from vehicles where id = v1 and user_id = a and not is_active) then
    raise exception 'FAIL: the previous owner''s row must survive deactivation';
  end if;
  perform 1 from reservations where id = res and vehicle_id = v1 and user_id = a;
  if not found then raise exception 'FAIL: history must still point at the row it was made against'; end if;

  -- Reactivating a plate somebody else now holds is refused with the CURRENT owner's
  -- classification — the unique index is the authority, not the earlier SELECT.
  r := set_member_vehicle_active(v1, true, sa, gen_random_uuid(),
                                 'f4f4f4f4-4444-4444-8444-444444444444');
  if r->>'reason' <> 'active_plate_owned_by_other' then
    raise exception 'FAIL: reactivating a re-issued plate: %', r;
  end if;
  perform 1 from audit_logs
   where request_id = 'f4f4f4f4-4444-4444-8444-444444444444'
     and action = 'vehicle.reactivate' and result = 'denied';
  if not found then raise exception 'FAIL: refused reactivation must be audited'; end if;

  -- And once B releases it, A can have it back — reactivate, not a second row.
  perform set_member_vehicle_active(v2, false, sa, gen_random_uuid(), gen_random_uuid());
  if (add_member_vehicle(a, 'VMM8888', sa, gen_random_uuid(), gen_random_uuid()))->>'reason'
       <> 'inactive_plate_exists' then
    raise exception 'FAIL: an owner with the plate in history must be pointed at reactivate';
  end if;
  r := set_member_vehicle_active(v1, true, sa, gen_random_uuid(), gen_random_uuid());
  if not (r->>'ok')::bool or not (r->>'is_active')::bool then
    raise exception 'FAIL: reactivation should succeed once the plate is free: %', r;
  end if;
  select count(*) into n from vehicles where license_plate_normalized = 'VMM8888';
  if n <> 2 then raise exception 'FAIL: reactivation must reuse the row, not stack a new one (got %)', n; end if;

  raise notice 'PASS: vehicle lifecycle — active-scoped uniqueness, guarded deactivation, plate re-issue without rewriting history';
end $$;

-- ── 42f. import_member gained an identity guard and an active-only plate lookup ──
-- The CSV keys members by PHONE, so a phone that is not in the DB used to mean "new member,
-- insert". With phone mutable, that is how one person becomes two rows — the second holding
-- none of their bindings, history, or eligibility. The guard makes it a human decision, and
-- lives in the RPC so dry-run and apply cannot answer differently.
do $$
declare
  sa uuid; a uuid; v1 uuid; r jsonb;
begin
  select id into sa from admin_accounts where username = 'vmm-sa';
  a := (create_member('vmm匯入甲', '0977300001', sa, gen_random_uuid(), gen_random_uuid()))->>'user_id';
  v1 := (add_member_vehicle(a, 'vmm-3333', sa, gen_random_uuid(), gen_random_uuid()))->>'vehicle_id';

  -- Same name, DIFFERENT phone → refuse to create a second identity. The status is the one
  -- an old client already knows (fail closed); conflict_kind is the new discriminant.
  r := import_member('vmm匯入甲', '0977300099', null, null, null, null, null, true);
  if r->>'status' <> 'phone_name_conflict' or r->>'conflict_kind' <> 'identity_candidate' then
    raise exception 'FAIL: import must refuse to create a same-name second identity: %', r;
  end if;
  if (r->'candidates'->0->>'id')::uuid <> a
     or r->'candidates'->0->>'evidence' <> 'same_name' then
    raise exception 'FAIL: identity candidates payload wrong: %', r;
  end if;

  -- Same name AND an active plate they hold → the evidence is stronger, and says so.
  r := import_member('vmm匯入甲', '0977300099', array['VMM3333'], null, null, null, null, true);
  if r->'candidates'->0->>'evidence' <> 'same_name_and_plate' then
    raise exception 'FAIL: an active plate match must raise the evidence: %', r;
  end if;

  -- …but an INACTIVE historical row must not. "A once had this plate, B has it now" is not
  -- evidence that A and B are the same person.
  perform set_member_vehicle_active(v1::uuid, false, sa, gen_random_uuid(), gen_random_uuid());
  r := import_member('vmm匯入甲', '0977300099', array['VMM3333'], null, null, null, null, true);
  if r->'candidates'->0->>'evidence' <> 'same_name' then
    raise exception 'FAIL: an inactive plate must not raise the identity evidence: %', r;
  end if;

  -- The existing phone-keyed path is untouched: same phone, different name still reports the
  -- OLD discriminant, so an old client's copy keeps working.
  r := import_member('vmm匯入乙', '0977300001', null, null, null, null, null, true);
  if r->>'status' <> 'phone_name_conflict' or r->>'conflict_kind' <> 'phone_name_mismatch'
     or r->>'existing_name' <> 'vmm匯入甲' then
    raise exception 'FAIL: the phone/name mismatch contract changed: %', r;
  end if;

  raise notice 'PASS: import_member refuses same-name second identities, scores evidence active-only, and keeps its old conflict contract';
end $$;

rollback;

\echo '== verify_schema.sql: all assertions passed =='
