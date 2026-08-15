-- Phase 9 Slice 2 — production-safe schema verification. Run against Supabase Cloud
-- AFTER `supabase db push`:
--   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/verify_schema_prod.sql
--
-- CATALOG-ONLY, ZERO DML. Every assertion reads pg_catalog/information_schema; nothing
-- here inserts, updates, or depends on seed data. This is why it is safe to run against
-- a fresh production database that has never run `supabase/seed.sql` (seed.sql is
-- dev-only and is never applied by `db push`).
--
-- This file is NOT a replacement for supabase/tests/verify_schema.sql (the local
-- verifier, run via `npm run db:verify`): that one exercises 37 behavioral/negative
-- assertions via DML inside a rolled-back transaction and depends on seed rows — it
-- cannot run against a fresh cloud database. The two files are COMPLEMENTS with
-- independent assertion counts: local verifies behavior via DML, this one verifies
-- structure and privileges via catalog reads. Do not compare their counts.
--
-- Assertions 1–20 below port the catalog-only subset of verify_schema.sql (its
-- assertions 11, 15–33) essentially unchanged — they never touched seed data or DML to
-- begin with. Assertions 21–24 are catalog-only equivalents of verify_schema.sql's
-- DML-based uniqueness checks (its assertions 1, 3, 7, and the plate-normalization
-- check), which cannot run here because they insert rows that violate a constraint.
-- Assertions 25+ verify the REVERSE of existing grant checks — that anon/authenticated
-- and PUBLIC do NOT hold privileges they should never have — since a verifier that only
-- checks "service_role can" never proves nothing else can.
--
-- Each assertion uses the same `do $$ ... if not ... then raise exception ... end $$;`
-- pattern as verify_schema.sql. A bare `select exists(...)` is NOT used anywhere here:
-- its result can be silently discarded, leaving `psql` to exit 0 on a failed check.

\set ON_ERROR_STOP on

-- ── 1. staff_checkin_view exposes is_priority, hides reason/penalty (verify_schema.sql #11) ─
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

-- ── 2. apply_staff_pin_failure exists + service_role can execute (verify_schema.sql #15) ─
do $$
begin
  perform 1 from pg_proc where proname = 'apply_staff_pin_failure';
  if not found then raise exception 'FAIL: apply_staff_pin_failure function missing'; end if;
  if not has_function_privilege('service_role', 'apply_staff_pin_failure(uuid,int)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on apply_staff_pin_failure';
  end if;
  raise notice 'PASS: apply_staff_pin_failure present with service_role execute grant';
end $$;

-- ── 3. notification_outbox lease columns + 'processing' status (verify_schema.sql #16) ─
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

-- ── 4. claim_notification_outbox exists + service_role execute (verify_schema.sql #17) ─
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

-- ── 5. staff_checkin_view exposes owner_notifiable, hides line_id/phone (verify_schema.sql #18) ─
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

-- ── 6. outbox_health exists + service_role execute (verify_schema.sql #19) ─────────────
do $$
begin
  perform 1 from pg_proc where proname = 'outbox_health';
  if not found then raise exception 'FAIL: outbox_health function missing'; end if;
  if not has_function_privilege('service_role', 'outbox_health(timestamptz,int)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on outbox_health';
  end if;
  raise notice 'PASS: outbox_health present with service_role execute grant';
end $$;

-- ── 7. apply_release 4-arg + 3-arg wrapper, service_role execute (verify_schema.sql #20) ─
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

-- ── 8. apply_cancellation 8-arg + 7-arg wrapper, service_role execute (verify_schema.sql #21) ─
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

-- ── 9. requeue_failed_outbox exists + service_role execute (verify_schema.sql #22) ─────
do $$
begin
  perform 1 from pg_proc where proname = 'requeue_failed_outbox';
  if not found then raise exception 'FAIL: requeue_failed_outbox function missing'; end if;
  if not has_function_privilege('service_role', 'requeue_failed_outbox(timestamptz,int,text)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on requeue_failed_outbox';
  end if;
  raise notice 'PASS: requeue_failed_outbox present with service_role execute grant';
end $$;

-- ── 10. pending_binding table + partial unique index + capture RPC grant (verify_schema.sql #23) ─
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

-- ── 11. binding_codes + pending_binding audit cols + approve/reject RPC grants (verify_schema.sql #24) ─
do $$
begin
  perform 1 from pg_class where relname = 'binding_codes' and relkind = 'r';
  if not found then raise exception 'FAIL: binding_codes table missing'; end if;

  perform 1 from pg_indexes where indexname = 'binding_codes_code_key';
  if not found then raise exception 'FAIL: binding_codes_code_key unique index missing'; end if;

  perform 1 from information_schema.columns
   where table_name = 'pending_binding'
     and column_name in ('approved_at', 'approved_user_id', 'rejected_at', 'rejected_reason')
   group by table_name having count(*) = 4;
  if not found then raise exception 'FAIL: pending_binding audit columns (approved_at/approved_user_id/rejected_at/rejected_reason) missing'; end if;

  perform 1 from pg_proc where proname = 'approve_pending_binding';
  if not found then raise exception 'FAIL: approve_pending_binding function missing'; end if;
  perform 1 from pg_proc where proname = 'reject_pending_binding';
  if not found then raise exception 'FAIL: reject_pending_binding function missing'; end if;

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

-- ── 12. eligibility_dependents + users_phone_key + import_member RPC grant (verify_schema.sql #25) ─
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

-- ── 13. member_sessions table + hashed-token unique + RLS + grant (verify_schema.sql #26) ─
do $$
begin
  perform 1 from pg_class where relname = 'member_sessions' and relkind = 'r';
  if not found then raise exception 'FAIL: member_sessions table missing'; end if;

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

-- ── 14. LIFF binding claim: XOR shape + phone canon + capture/approve RPCs (verify_schema.sql #27) ─
do $$
begin
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
  if not has_function_privilege('service_role', 'approve_pending_binding(uuid,bigint,timestamptz,boolean,uuid)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on approve_pending_binding(revision-guarded)';
  end if;
  perform 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'approve_pending_binding' and p.pronargs = 3;
  if found then raise exception 'FAIL: stale 3-arg approve_pending_binding still present'; end if;

  raise notice 'PASS: liff binding claim columns/constraints + capture/approve RPC grants present';
end $$;

-- ── 15. member apply RPC + allocation claim lock protocol (verify_schema.sql #28) ─────
do $$
begin
  perform 1 from pg_proc where proname = 'apply_reservation';
  if not found then raise exception 'FAIL: apply_reservation function missing'; end if;
  if not has_function_privilege('service_role', 'apply_reservation(uuid,uuid,uuid,boolean,smallint,timestamptz)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on apply_reservation';
  end if;
  perform 1 from pg_proc where proname = 'claim_friday_allocation';
  if not found then raise exception 'FAIL: claim_friday_allocation function missing'; end if;
  if not has_function_privilege('service_role', 'claim_friday_allocation(uuid,text)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on claim_friday_allocation';
  end if;
  raise notice 'PASS: apply_reservation + claim_friday_allocation RPCs + grants present';
end $$;

-- ── 16. offer expiry guard: apply_offer_resolution carries p_expiry_guard (verify_schema.sql #29) ─
do $$
begin
  if not has_function_privilege('service_role',
    'apply_offer_resolution(uuid,uuid,text,timestamptz,jsonb,jsonb,jsonb,boolean)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on apply_offer_resolution(8-arg)';
  end if;
  perform 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'apply_offer_resolution' and p.pronargs = 7;
  if found then raise exception 'FAIL: stale 7-arg apply_offer_resolution still present'; end if;
  raise notice 'PASS: apply_offer_resolution expiry-guard signature present (old 7-arg gone)';
end $$;

-- ── 17. Admin accounts + sessions + binding decider audit (verify_schema.sql #30) ─────
do $$
begin
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

  if not has_function_privilege('service_role', 'apply_admin_login_failure(uuid,timestamptz,int,int)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on apply_admin_login_failure';
  end if;

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

-- ── 18. Admin account management RPCs (verify_schema.sql #31) ──────────────────────────
do $$
begin
  -- Signature gained p_acting_session_id + p_request_id when 0030 made this the
  -- audited exemplar; assertion 27 pins the audit-specific properties.
  if not has_function_privilege('service_role', 'set_admin_disabled(uuid,uuid,uuid,boolean,timestamptz,uuid)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on set_admin_disabled';
  end if;
  -- Signature gained p_acting_session_id + p_request_id in 0035, when the success path
  -- became audited (assertion 29 pins the rest).
  if not has_function_privilege('service_role', 'reset_admin_password(uuid,uuid,uuid,text,uuid)', 'execute') then
    raise exception 'FAIL: service_role lacks execute on reset_admin_password';
  end if;
  raise notice 'PASS: admin account management RPCs (set_admin_disabled, reset_admin_password) present';
end $$;

-- ── 19. Binding PII retention (verify_schema.sql #32) ──────────────────────────────────
do $$
declare
  v_def text;
begin
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

-- ── 20. Pastoral resolution + staff-PIN issuance audit (verify_schema.sql #33) ─────────
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

-- ═══════════════════════════════════════════════════════════════════════════════════
-- Catalog-only equivalents of verify_schema.sql's DML-based uniqueness checks (its
-- assertions #1, #3, #7's plate half, and the sunday_date column constraint). Those
-- checks work by INSERTing a row that should violate a constraint and catching the
-- error — impossible here without DML. These instead confirm the constraint/index
-- EXISTS with the right shape, without exercising it.
-- ═══════════════════════════════════════════════════════════════════════════════════

-- ── 21. weekly_events.sunday_date has a UNIQUE constraint ──────────────────────────────
do $$
begin
  perform 1
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu
      on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
    where tc.table_name = 'weekly_events'
      and tc.constraint_type = 'UNIQUE'
      and kcu.column_name = 'sunday_date';
  if not found then raise exception 'FAIL: weekly_events.sunday_date has no UNIQUE constraint'; end if;
  raise notice 'PASS: weekly_events.sunday_date UNIQUE constraint present';
end $$;

-- ── 22. users_line_id_key: partial unique index on line_id where not null ──────────────
do $$
declare
  v_indisunique boolean;
  v_pred text;
begin
  select ix.indisunique, pg_get_expr(ix.indpred, ix.indrelid)
    into v_indisunique, v_pred
    from pg_index ix
    join pg_class i on i.oid = ix.indexrelid
    where i.relname = 'users_line_id_key';
  if not found then raise exception 'FAIL: users_line_id_key index missing'; end if;
  if not v_indisunique then raise exception 'FAIL: users_line_id_key is not unique'; end if;
  if v_pred is null or v_pred !~* 'line_id.*is not null' then
    raise exception 'FAIL: users_line_id_key predicate does not exclude NULL line_id (got: %)', v_pred;
  end if;
  perform 1
    from pg_index ix
    join pg_class i on i.oid = ix.indexrelid
    join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = any(ix.indkey)
    where i.relname = 'users_line_id_key' and a.attname = 'line_id';
  if not found then raise exception 'FAIL: users_line_id_key is not indexing line_id'; end if;
  raise notice 'PASS: users_line_id_key partial unique index on line_id (where not null) present';
end $$;

-- ── 23. Plate uniqueness: one ACTIVE holder per normalized plate ────────────────────────
-- 0001–0037 spelled this as a GLOBAL unique index (vehicles_plate_normalized_key); 0038
-- replaced it with vehicles_active_plate_uq, partial on is_active, because a plate must be
-- re-issuable to a new owner while the previous owner's row survives as history. The
-- invariant this assertion protects is unchanged in spirit — no two CURRENT cars share a
-- plate — and the "no unconditional unique index" half is asserted in the 0038 block below.
do $$
declare
  v_indisunique boolean;
  v_pred text;
begin
  select ix.indisunique, pg_get_expr(ix.indpred, ix.indrelid) into v_indisunique, v_pred
    from pg_index ix
    join pg_class i on i.oid = ix.indexrelid
    where i.relname = 'vehicles_active_plate_uq';
  if not found then raise exception 'FAIL: vehicles_active_plate_uq index missing'; end if;
  if not v_indisunique then raise exception 'FAIL: vehicles_active_plate_uq is not unique'; end if;
  if v_pred is distinct from 'is_active' then
    raise exception 'FAIL: vehicles_active_plate_uq must be partial on is_active (got: %)', v_pred;
  end if;
  perform 1
    from pg_index ix
    join pg_class i on i.oid = ix.indexrelid
    join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = any(ix.indkey)
    where i.relname = 'vehicles_active_plate_uq' and a.attname = 'license_plate_normalized';
  if not found then raise exception 'FAIL: vehicles_active_plate_uq is not indexing license_plate_normalized'; end if;
  raise notice 'PASS: vehicles_active_plate_uq unique index on license_plate_normalized (where is_active) present';
end $$;

-- ── 24. reservations_one_active_per_member: partial unique excluding cancelled_* ────────
do $$
declare
  v_indisunique boolean;
  v_pred text;
begin
  select ix.indisunique, pg_get_expr(ix.indpred, ix.indrelid)
    into v_indisunique, v_pred
    from pg_index ix
    join pg_class i on i.oid = ix.indexrelid
    where i.relname = 'reservations_one_active_per_member';
  if not found then raise exception 'FAIL: reservations_one_active_per_member index missing'; end if;
  if not v_indisunique then raise exception 'FAIL: reservations_one_active_per_member is not unique'; end if;
  if v_pred is null or v_pred !~* 'cancelled_by_user' or v_pred !~* 'cancelled_late' then
    raise exception 'FAIL: reservations_one_active_per_member predicate does not exclude both cancelled_* statuses (got: %)', v_pred;
  end if;
  perform 1
    from pg_index ix
    join pg_class i on i.oid = ix.indexrelid
    join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = any(ix.indkey)
    where i.relname = 'reservations_one_active_per_member' and a.attname = 'weekly_event_id';
  if not found then raise exception 'FAIL: reservations_one_active_per_member is not indexing weekly_event_id'; end if;
  perform 1
    from pg_index ix
    join pg_class i on i.oid = ix.indexrelid
    join pg_attribute a on a.attrelid = ix.indrelid and a.attnum = any(ix.indkey)
    where i.relname = 'reservations_one_active_per_member' and a.attname = 'user_id';
  if not found then raise exception 'FAIL: reservations_one_active_per_member is not indexing user_id'; end if;
  raise notice 'PASS: reservations_one_active_per_member partial unique (excluding cancelled_*) present';
end $$;

-- ═══════════════════════════════════════════════════════════════════════════════════
-- Reverse grant checks: proving anon/authenticated/PUBLIC do NOT hold privileges they
-- should never have. A verifier that only checks "service_role can" never proves
-- nothing else can — these close that gap for the tables/RPCs this file touches.
-- ═══════════════════════════════════════════════════════════════════════════════════

-- ── 25. Sensitive tables: anon/authenticated hold no direct privileges ─────────────────
-- Full SELECT/INSERT/UPDATE/DELETE x anon/authenticated matrix on every sensitive table
-- this file otherwise touches. admin_accounts/admin_sessions/member_sessions are
-- included here even though earlier assertions (13, 17) already check an anon-SELECT
-- slice of them — those were ported from the local verifier as-is; this assertion is
-- the single place that completes the full negative-grant matrix for all six tables.
do $$
declare
  t text;
  tables text[] := array[
    'pending_binding', 'binding_codes', 'pastoral_care_alerts',
    'admin_accounts', 'admin_sessions', 'member_sessions'
  ];
begin
  foreach t in array tables loop
    if has_table_privilege('anon', t, 'select') or has_table_privilege('anon', t, 'insert')
       or has_table_privilege('anon', t, 'update') or has_table_privilege('anon', t, 'delete') then
      raise exception 'FAIL: anon holds a direct privilege on %', t;
    end if;
    if has_table_privilege('authenticated', t, 'select') or has_table_privilege('authenticated', t, 'insert')
       or has_table_privilege('authenticated', t, 'update') or has_table_privilege('authenticated', t, 'delete') then
      raise exception 'FAIL: authenticated holds a direct privilege on %', t;
    end if;
  end loop;
  raise notice 'PASS: anon/authenticated hold no direct privileges on pending_binding/binding_codes/pastoral_care_alerts/admin_accounts/admin_sessions/member_sessions';
end $$;

-- ── 26. Sensitive RPCs: PUBLIC holds no EXECUTE (checked via ACL, not has_function_privilege) ─
-- PUBLIC is not an ordinary database role — has_function_privilege('PUBLIC', ...) is
-- unreliable (no such role) and is not used here. Instead this resolves each signature
-- to a concrete function OID FIRST (to_regprocedure — returns NULL, never an error, on a
-- typo'd/missing signature) and fails loudly if that resolution fails, before decomposing
-- the function's ACL (defaulting to the owner's implicit ACL when proacl is null, i.e. no
-- explicit GRANT/REVOKE has ever touched it) and checking for grantee = 0, which is
-- pg_catalog's sentinel for the PUBLIC pseudo-role.
--
-- The two-step split matters: `select exists(...) into x` ALWAYS yields true or false,
-- never null (EXISTS is a boolean operator over a subquery, unaffected by the subquery
-- being empty) — so folding "not found" and "found but PUBLIC has no EXECUTE" into one
-- exists() check, as an earlier draft of this file did, silently PASSES a signature that
-- doesn't resolve to any function at all. Resolving the OID first turns that into a
-- loud failure instead.
do $$
declare
  fn_oid oid;
  public_execute boolean;
  fns text[] := array[
    'approve_pending_binding(uuid,bigint,timestamptz,boolean,uuid)',
    'reject_pending_binding(uuid,text,timestamptz,uuid)',
    'resolve_pastoral_alert(uuid,uuid,text,boolean,timestamptz)',
    'redact_decided_binding_pii(timestamptz,int,int,boolean)',
    'import_member(text,text,text[],p2_reason,date,date,jsonb,boolean)',
    'capture_pending_binding(text,text,text,timestamptz)',
    'capture_liff_binding_claim(text,text,text,timestamptz)',
    -- 0030 made these SECURITY DEFINER (they run as the owner), which turns a stray
    -- PUBLIC EXECUTE from a latent annoyance into privilege escalation.
    'set_admin_disabled(uuid,uuid,uuid,boolean,timestamptz,uuid)',
    'private.append_audit_log(audit_actor_type,uuid,uuid,text,text,text,uuid,uuid,uuid,audit_result,jsonb)',
    'set_weekly_capacity(uuid,date,int,int,int,uuid,uuid,uuid)'
  ];
  sig text;
begin
  foreach sig in array fns loop
    fn_oid := to_regprocedure(sig);
    if fn_oid is null then
      raise exception 'FAIL: function signature % does not resolve to any function (typo, or missing revoke-from-public migration never ran)', sig;
    end if;

    select exists (
      select 1
        from pg_proc p
        join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl on true
        where p.oid = fn_oid
          and acl.grantee = 0
          and acl.privilege_type = 'EXECUTE'
    ) into public_execute;
    if public_execute then
      raise exception 'FAIL: PUBLIC holds EXECUTE on % — expected an explicit revoke-from-public in the owning migration', sig;
    end if;
  end loop;
  raise notice 'PASS: PUBLIC holds no EXECUTE on the sensitive binding/pastoral/import/retention RPCs';
end $$;

-- ── 27. Audit substrate: append-only + app-unforgeable (verify_schema.sql #34) ───
-- Catalog-only half of local assertion 34. The behavioural half (triggers still block
-- once DML is granted back) needs DML and stays local-only — but the properties below
-- are exactly the ones a blanket re-grant or a careless `create or replace` would undo
-- in production, which is where it would matter most.
do $$
declare
  v_priv text;
begin
  perform 1 from pg_class where relname = 'audit_logs' and relkind = 'r';
  if not found then raise exception 'FAIL: audit_logs table missing'; end if;

  -- The app principal reads the log and nothing else. TRUNCATE is checked explicitly:
  -- DELETE does not imply it, and it never fires a row-level trigger.
  foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
    if has_table_privilege('service_role', 'audit_logs', v_priv) then
      raise exception 'FAIL: service_role must not hold % on audit_logs', v_priv;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'audit_logs', 'SELECT') then
    raise exception 'FAIL: service_role lacks SELECT on audit_logs';
  end if;

  -- The app cannot reach the writer, so it cannot forge a row even though it can
  -- legitimately call the RPCs that write one.
  if has_schema_privilege('service_role', 'private', 'usage') then
    raise exception 'FAIL: service_role must not hold USAGE on schema private';
  end if;

  if to_regprocedure('private.append_audit_log(audit_actor_type,uuid,uuid,text,text,text,uuid,uuid,uuid,audit_result,jsonb)') is null then
    raise exception 'FAIL: private.append_audit_log missing';
  end if;

  -- SECURITY DEFINER is what lets the audited RPC reach the writer; an unpinned
  -- search_path would make that a privilege-escalation vector.
  if not exists (select 1 from pg_proc where proname = 'set_admin_disabled' and prosecdef) then
    raise exception 'FAIL: set_admin_disabled must be SECURITY DEFINER';
  end if;
  if exists (
    select 1 from pg_proc
     where proname in ('set_admin_disabled', 'append_audit_log')
       and prosecdef
       and (proconfig is null or array_to_string(proconfig, ',') not like '%search_path%')
  ) then
    raise exception 'FAIL: a SECURITY DEFINER audit function does not pin search_path';
  end if;

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

  perform 1 from pg_trigger where tgname = 'audit_logs_no_mutation';
  if not found then raise exception 'FAIL: audit_logs_no_mutation trigger missing'; end if;
  perform 1 from pg_trigger where tgname = 'audit_logs_no_truncate';
  if not found then raise exception 'FAIL: audit_logs_no_truncate trigger missing'; end if;

  raise notice 'PASS: audit substrate append-only grants, private writer, SECURITY DEFINER exemplar present';
end $$;

-- ── 28. Weekly capacity admin: folded admin_reserved + guards (verify_schema.sql #35) ─
-- Catalog-only half. The behavioural half (the guard actually refusing a below-promised
-- cut) needs DML and stays local — but these are the properties a careless migration
-- would undo in production, where admin_reserved silently going non-zero would make the
-- UI's single 「保留·停用」number disagree with what the allocator actually computes.
do $$
declare
  v_sig text := 'set_weekly_capacity(uuid,date,int,int,int,uuid,uuid,uuid)';
  v_priv text;
begin
  if not exists (select 1 from pg_constraint where conname = 'weekly_events_admin_reserved_folded_ck') then
    raise exception 'FAIL: weekly_events_admin_reserved_folded_ck missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'weekly_events_blocked_within_total_ck') then
    raise exception 'FAIL: weekly_events_blocked_within_total_ck missing';
  end if;

  perform 1 from information_schema.columns
   where table_name = 'weekly_events' and column_name = 'capacity_version';
  if not found then raise exception 'FAIL: weekly_events.capacity_version missing'; end if;

  if to_regprocedure(v_sig) is null then
    raise exception 'FAIL: set_weekly_capacity missing';
  end if;
  if not exists (select 1 from pg_proc where proname = 'set_weekly_capacity' and prosecdef) then
    raise exception 'FAIL: set_weekly_capacity must be SECURITY DEFINER';
  end if;
  if exists (
    select 1 from pg_proc
     where proname = 'set_weekly_capacity' and prosecdef
       and (proconfig is null or array_to_string(proconfig, ',') not like '%search_path%')
  ) then
    raise exception 'FAIL: SECURITY DEFINER set_weekly_capacity does not pin search_path';
  end if;
  foreach v_priv in array array['anon', 'authenticated'] loop
    if has_function_privilege(v_priv, v_sig, 'execute') then
      raise exception 'FAIL: % must not execute set_weekly_capacity', v_priv;
    end if;
  end loop;
  if not has_function_privilege('service_role', v_sig, 'execute') then
    raise exception 'FAIL: service_role lacks execute on set_weekly_capacity';
  end if;

  raise notice 'PASS: weekly capacity admin columns/constraints/RPC present and locked down';
end $$;

-- ── 29. P2 eligibility model (verify_schema.sql #36) ─────────────────────────────
-- Catalog-only twin. The behavioural half (#36b: the column tracks review_status and
-- rejects direct writes) needs DML and stays local-only, per this file's header.
do $$
declare
  v_name text;
begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
     where t.typname = 'p2_review_status' and e.enumlabel = 'unreviewed'
  ) then
    raise exception 'FAIL: p2_review_status is missing the neutral unreviewed state';
  end if;

  if not exists (
    select 1 from pg_attribute
     where attrelid = 'user_eligibility'::regclass
       and attname = 'p2_eligible' and attgenerated = 's'
  ) then
    raise exception 'FAIL: user_eligibility.p2_eligible must be a STORED generated column';
  end if;

  -- No date term: it answers "is this approved?", never "is this valid today?".
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

  foreach v_name in array array[
    'eligibility_window_ordered_ck',
    'eligibility_child_birthdate_reason_ck',
    'eligibility_reason_present'
  ] loop
    if not exists (select 1 from pg_constraint where conname = v_name) then
      raise exception 'FAIL: constraint % missing on user_eligibility', v_name;
    end if;
  end loop;

  perform 1 from information_schema.columns
   where table_name = 'user_eligibility' and column_name = 'review_version';
  if not found then raise exception 'FAIL: user_eligibility.review_version missing'; end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'user_eligibility_reviewed_by_fkey'
       and confrelid = 'admin_accounts'::regclass
  ) then
    raise exception 'FAIL: user_eligibility.reviewed_by must reference admin_accounts(id)';
  end if;

  raise notice 'PASS: P2 eligibility model — review_status authoritative, p2_eligible generated and date-free';
end $$;

-- ── 30. Audit sanitizer blocks birthdate VALUES (verify_schema.sql #36c) ─────────
-- Catalog-only: the behavioural probe writes rows, and audit_logs is append-only, so it
-- stays local. Here we assert the guard's SOURCE is present — 0030's denylist is exact-match
-- and cannot see p2_child_birthdate, so this pattern check is the only thing standing between
-- a minor's DOB and a row nobody can ever delete.
do $$
begin
  if not exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private' and p.proname = 'append_audit_log'
       and p.prosrc like '%birth_?date%'
  ) then
    raise exception 'FAIL: private.append_audit_log lost the birthdate-shaped key guard (2B-2a/#10)';
  end if;
  raise notice 'PASS: audit sanitizer retains the birthdate-value guard';
end $$;

-- ── 31. P2 write path (verify_schema.sql #37) ───────────────────────────────────
-- Catalog-only twin. The behavioural half (#37b: creates for a no-row member, governs on
-- approve, refuses to review a revoked row) writes rows and stays local.
do $$
declare
  v_priv text;
  v_sig  text;
  v_name text;
begin
  foreach v_sig in array array[
    'set_p2_eligibility(uuid,int,text,p2_reason,date,date,date,date,text,uuid,uuid,uuid)',
    'mark_p2_reviewed(uuid,int,date,uuid,uuid,uuid)'
  ] loop
    if to_regprocedure(v_sig) is null then
      raise exception 'FAIL: % is missing', v_sig;
    end if;
    if not exists (select 1 from pg_proc where oid = to_regprocedure(v_sig) and prosecdef) then
      raise exception 'FAIL: % must be SECURITY DEFINER', v_sig;
    end if;
    if not exists (
      select 1 from pg_proc where oid = to_regprocedure(v_sig)
         and array_to_string(proconfig, ',') like '%search_path%'
    ) then
      raise exception 'FAIL: SECURITY DEFINER % must pin search_path', v_sig;
    end if;
    foreach v_priv in array array['anon', 'authenticated'] loop
      if has_function_privilege(v_priv, v_sig, 'execute') then
        raise exception 'FAIL: % must not execute %', v_priv, v_sig;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_sig, 'execute') then
      raise exception 'FAIL: service_role lacks execute on %', v_sig;
    end if;
  end loop;

  foreach v_name in array array['eligibility_reviewed_pair_ck', 'eligibility_child_expiry_derived_ck'] loop
    if not exists (select 1 from pg_constraint where conname = v_name) then
      raise exception 'FAIL: constraint % missing on user_eligibility', v_name;
    end if;
  end loop;

  if not exists (select 1 from pg_proc where proname = 'child_companion_valid_until' and provolatile = 'i') then
    raise exception 'FAIL: child_companion_valid_until must be IMMUTABLE or its CHECK cannot call it';
  end if;

  -- The DB session is UTC in this deployment, so current_date is a UTC date and the past-date
  -- guards would misfire between 00:00-08:00 Taipei. Comments are stripped before matching
  -- because both functions explain the hazard in prose.
  foreach v_sig in array array['set_p2_eligibility', 'mark_p2_reviewed'] loop
    if not exists (select 1 from pg_proc where proname = v_sig and prosrc like '%Asia/Taipei%') then
      raise exception 'FAIL: % lost its Asia/Taipei date computation', v_sig;
    end if;
    if exists (
      select 1 from pg_proc where proname = v_sig
         and regexp_replace(prosrc, '--[^\n]*', '', 'g') ~ '\mcurrent_date\M'
    ) then
      raise exception 'FAIL: % uses current_date — that is a UTC date on this server', v_sig;
    end if;
  end loop;

  raise notice 'PASS: P2 write RPCs present and locked down, invariants + Taipei date pinned';
end $$;

-- ── 28. Audit retention purge locked down (verify_schema.sql #38) ─────────────────
-- Catalog-only half of local assertion 38 (the behavioural delete/seam probe stays
-- local). These are the properties a blanket re-grant or careless create-or-replace
-- would undo in prod: the fn is SECURITY DEFINER + search_path pinned, only service_role
-- executes it, its owner equals audit_logs' owner (or lock 2 would reject every purge),
-- and the trigger still carries the escape hatch.
do $$
begin
  if to_regprocedure('purge_audit_logs(int,int,boolean,uuid)') is null then
    raise exception 'FAIL: purge_audit_logs missing';
  end if;
  if not exists (select 1 from pg_proc where proname = 'purge_audit_logs' and prosecdef) then
    raise exception 'FAIL: purge_audit_logs must be SECURITY DEFINER';
  end if;
  if exists (
    select 1 from pg_proc
     where proname = 'purge_audit_logs'
       and prosecdef
       and (proconfig is null or array_to_string(proconfig, ',') not like '%search_path%')
  ) then
    raise exception 'FAIL: purge_audit_logs does not pin search_path';
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
    raise exception 'FAIL: purge_audit_logs owner <> audit_logs owner — lock 2 would reject every purge';
  end if;
  if not exists (
    select 1 from pg_proc where proname = 'audit_logs_block_mutation' and prosrc like '%audit.allow_purge%'
  ) then
    raise exception 'FAIL: audit_logs_block_mutation lost the purge escape hatch (2A-3)';
  end if;

  raise notice 'PASS: purge_audit_logs present, locked down, owner-matched, escape hatch intact';
end $$;

-- ── 29. Admin role tiers (verify_schema.sql #39) ──────────────────────────────────
-- Catalog-only half of local assertion 39 (the behavioural role-snapshot probe stays
-- local — it writes audit rows, which are append-only and could not be cleaned up here).
-- ⚠️ This is the assertion to check FIRST after applying 0035 to prod: the app selects
-- admin_accounts.role on every admin request, so it must be deployed DB-first.
do $$
declare
  v_default text;
begin
  if (select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid
       where t.typname = 'admin_role') <> 2 then
    raise exception 'FAIL: admin_role must have exactly the two implemented values';
  end if;

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

  -- The backfill: prod must not be left with an account that silently became a clerk.
  if exists (select 1 from admin_accounts where disabled_at is null) and not exists (
    select 1 from admin_accounts where disabled_at is null and role = 'superadmin'
  ) then
    raise exception 'FAIL: no active superadmin remains — nobody can manage accounts';
  end if;

  -- NOT VALID on purpose and FOREVER (pre-0035 admin rows legitimately have no role).
  if not exists (
    select 1 from pg_constraint where conname = 'audit_logs_admin_role_snapshot_ck' and contype = 'c'
  ) then
    raise exception 'FAIL: audit_logs_admin_role_snapshot_ck missing';
  end if;
  if (select convalidated from pg_constraint where conname = 'audit_logs_admin_role_snapshot_ck') then
    raise exception 'FAIL: audit_logs_admin_role_snapshot_ck was validated — pre-0035 rows are legitimately null';
  end if;

  if not exists (select 1 from pg_proc where proname = 'reset_admin_password' and prosecdef) then
    raise exception 'FAIL: reset_admin_password must be SECURITY DEFINER to reach the audit writer';
  end if;
  if exists (
    select 1 from pg_proc
     where proname = 'reset_admin_password'
       and prosecdef
       and (proconfig is null or array_to_string(proconfig, ',') not like '%search_path%')
  ) then
    raise exception 'FAIL: reset_admin_password does not pin search_path';
  end if;
  if exists (
    select 1 from pg_proc
     where proname = 'reset_admin_password'
       and pg_get_function_identity_arguments(oid) = 'uuid, uuid, text'
  ) then
    raise exception 'FAIL: the pre-audit 3-arg reset_admin_password overload still exists';
  end if;

  raise notice 'PASS: admin_role enum + column + backfill + audited reset_admin_password are in place';
end $$;

-- ── 30. Admin role management RPCs (verify_schema.sql #40) ────────────────────────
-- Catalog-only half (the behavioural probes stay local — they write audit rows).
-- ⚠️ Like #29, deploy DB-first: the new app calls these three RPCs, which do not exist
-- until 0036 lands.
do $$
declare
  v_sig text;
  v_priv text;
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
      raise exception 'FAIL: % must be SECURITY DEFINER', v_sig;
    end if;
    if exists (
      select 1 from pg_proc where oid = to_regprocedure(v_sig)
        and prosecdef
        and (proconfig is null or array_to_string(proconfig, ',') not like '%search_path%')
    ) then
      raise exception 'FAIL: % does not pin search_path', v_sig;
    end if;
    foreach v_priv in array array['anon', 'authenticated'] loop
      if has_function_privilege(v_priv, v_sig, 'execute') then
        raise exception 'FAIL: % must not execute %', v_priv, v_sig;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_sig, 'execute') then
      raise exception 'FAIL: service_role lacks execute on %', v_sig;
    end if;
    -- Argument NAMES: PostgREST calls these by named argument, so pin the p_* contract,
    -- not just the type signature.
    if pg_get_function_arguments(to_regprocedure(v_sig)) is distinct from (v_expected ->> v_sig) then
      raise exception 'FAIL: % argument names drifted from the p_* contract', v_sig;
    end if;
    if (select prorettype from pg_proc where oid = to_regprocedure(v_sig)) <> 'jsonb'::regtype then
      raise exception 'FAIL: % must return jsonb', v_sig;
    end if;
  end loop;

  raise notice 'PASS: role management RPCs present, SECURITY DEFINER, named-arg contract + return type pinned';
end $$;

-- ── Member roster export 0037 runtime contract (Wave 3 3d / #5B-a) ───────────────
-- Both functions 0037 adds and the export route depends on at runtime:
--   · log_member_roster_export: present, SECURITY DEFINER + pinned search_path,
--     service_role-only execute, returns jsonb, owner-matched with the audit writer.
--   · db_now(): the cutoff clock the service reads before paging — present, returns
--     timestamptz, service_role-only. Pinned HERE (same deploy gate) so a missing/grant-
--     drifted db_now can't pass db:verify:remote and then 500 the export in prod.
do $$
declare
  v_sig constant text := 'log_member_roster_export(uuid,uuid,uuid,integer)';
  v_writer_owner oid := (select proowner from pg_proc
    where oid = to_regprocedure('private.append_audit_log(audit_actor_type,uuid,uuid,text,text,text,uuid,uuid,uuid,audit_result,jsonb)'));
begin
  if to_regprocedure(v_sig) is null then
    raise exception 'FAIL: % missing', v_sig;
  end if;
  if not exists (select 1 from pg_proc where oid = to_regprocedure(v_sig) and prosecdef
      and array_to_string(proconfig, ',') like '%search_path%') then
    raise exception 'FAIL: % must be SECURITY DEFINER with pinned search_path', v_sig;
  end if;
  if has_function_privilege('anon', v_sig, 'execute')
     or has_function_privilege('authenticated', v_sig, 'execute')
     or has_function_privilege('public', v_sig, 'execute') then
    raise exception 'FAIL: % must be executable only by service_role', v_sig;
  end if;
  if not has_function_privilege('service_role', v_sig, 'execute') then
    raise exception 'FAIL: service_role lacks execute on %', v_sig;
  end if;
  if (select prorettype from pg_proc where oid = to_regprocedure(v_sig)) <> 'jsonb'::regtype then
    raise exception 'FAIL: % must return jsonb', v_sig;
  end if;
  if (select proowner from pg_proc where oid = to_regprocedure(v_sig)) <> v_writer_owner then
    raise exception 'FAIL: % owner <> append_audit_log owner', v_sig;
  end if;

  -- db_now(): the export's cutoff clock, same migration, same deploy gate.
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

  raise notice 'PASS: member roster export 0037 contract (audit RPC + db_now) present, SECURITY DEFINER, owner-matched, service_role-only';
end $$;

-- ── Member maintenance 0038 runtime contract (Tier 0-2) ──────────────────────────
-- The catalog-only half of verify_schema.sql §42. What must hold in PRODUCTION before the
-- new app is promoted (the migration is A✅/B❌ — the app calls RPCs that do not exist on
-- an un-migrated DB), plus the three structures whose drift is silent:
--   · the name-match key is generated THROUGH the shared function (one authority);
--   · plate uniqueness is ACTIVE-scoped and the old global unique index is gone — with it
--     still present, deactivation is pointless because a plate could never be re-issued;
--   · the retention index predicate covers the new snapshot column, or the daily PII job
--     stops matching the rows it is supposed to clear.
do $$
declare
  v_sig text;
  v_priv text;
  v_gen char;
  v_expr text;
  v_writer_owner oid := (select proowner from pg_proc
    where oid = to_regprocedure('private.append_audit_log(audit_actor_type,uuid,uuid,text,text,text,uuid,uuid,uuid,audit_result,jsonb)'));
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
  -- IMMUTABLE is a correctness requirement, not a hint: the generated column cannot exist
  -- without it, so a volatility drift means the substrate below is not what it claims.
  if to_regprocedure('normalize_member_name_for_match(text)') is null then
    raise exception 'FAIL: normalize_member_name_for_match(text) missing';
  end if;
  if (select provolatile from pg_proc where oid = to_regprocedure('normalize_member_name_for_match(text)')) <> 'i' then
    raise exception 'FAIL: normalize_member_name_for_match must be IMMUTABLE';
  end if;

  select a.attgenerated, pg_get_expr(d.adbin, d.adrelid)
    into v_gen, v_expr
    from pg_attribute a
    left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'users'::regclass and a.attname = 'member_name_match_key';
  if v_gen is distinct from 's' then
    raise exception 'FAIL: users.member_name_match_key missing or not STORED-generated';
  end if;
  if v_expr is null or v_expr not like '%normalize_member_name_for_match%' then
    raise exception 'FAIL: member_name_match_key must be generated by the shared function';
  end if;
  if exists (select 1 from pg_index
      where indrelid = 'users'::regclass and indisunique
        and pg_get_indexdef(indexrelid) like '%member_name_match_key%') then
    raise exception 'FAIL: member_name_match_key must NOT be unique — homonyms are legal members';
  end if;

  if not exists (select 1 from pg_attribute
      where attrelid = 'pending_binding'::regclass and attname = 'matched_user_id_at_capture'
        and atttypid = 'uuid'::regtype and not attisdropped) then
    raise exception 'FAIL: pending_binding.matched_user_id_at_capture missing (or not uuid)';
  end if;
  select pg_get_expr(indpred, indrelid) into v_expr from pg_index
   where indexrelid = 'pending_binding_pii_retention_idx'::regclass;
  if v_expr is null or v_expr not like '%matched_user_id_at_capture%' then
    raise exception 'FAIL: retention index predicate must include matched_user_id_at_capture';
  end if;

  if not exists (
    select 1 from pg_index
     where indexrelid = 'vehicles_active_plate_uq'::regclass
       and indisunique and pg_get_expr(indpred, indrelid) = 'is_active'
  ) then
    raise exception 'FAIL: vehicles_active_plate_uq must be UNIQUE and partial on is_active';
  end if;
  if exists (
    select 1 from pg_index
     where indrelid = 'vehicles'::regclass and indisunique and indpred is null
       and pg_get_indexdef(indexrelid) like '%license_plate_normalized%'
  ) then
    raise exception 'FAIL: an UNCONDITIONAL unique index on license_plate_normalized still exists — plates could never be re-issued';
  end if;

  for v_sig in select jsonb_object_keys(v_expected) loop
    if to_regprocedure(v_sig) is null then
      raise exception 'FAIL: % missing (exact signature)', v_sig;
    end if;
    if not exists (select 1 from pg_proc where oid = to_regprocedure(v_sig) and prosecdef
        and array_to_string(proconfig, ',') like '%search_path%') then
      raise exception 'FAIL: % must be SECURITY DEFINER with pinned search_path', v_sig;
    end if;
    foreach v_priv in array array['anon', 'authenticated', 'public'] loop
      if has_function_privilege(v_priv, v_sig, 'execute') then
        raise exception 'FAIL: % must not execute %', v_priv, v_sig;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_sig, 'execute') then
      raise exception 'FAIL: service_role lacks execute on %', v_sig;
    end if;
    if pg_get_function_arguments(to_regprocedure(v_sig)) is distinct from (v_expected ->> v_sig) then
      raise exception 'FAIL: % argument names drifted', v_sig;
    end if;
    if (select prorettype from pg_proc where oid = to_regprocedure(v_sig)) <> 'jsonb'::regtype then
      raise exception 'FAIL: % must return jsonb', v_sig;
    end if;
    if (select proowner from pg_proc where oid = to_regprocedure(v_sig)) <> v_writer_owner then
      raise exception 'FAIL: % owner <> append_audit_log owner — it could not reach the writer', v_sig;
    end if;
  end loop;

  raise notice 'PASS: member maintenance 0038 contract — name-match authority, active-plate uniqueness, snapshot retention, 4 RPCs pinned';
end $$;

\echo '== verify_schema_prod.sql: all 36 assertions passed =='
