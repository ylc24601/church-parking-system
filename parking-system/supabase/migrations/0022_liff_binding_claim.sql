-- Phase 7 Slice 2: LIFF binding claim (phone claim) + approval hardening.
-- The /member LIFF page lets an UNBOUND member submit a claim (name + mobile phone) after the
-- server verifies their LINE identity. The claim lands here as a pending_binding row with
-- claim_source='liff'; an admin approves it by matching claimed_phone against users_phone_key
-- (users.phone_number). NO auto-bind: approval stays a human decision.
--
-- Also fixes a preview/apply TOCTOU race that the keyword flow shares: a member re-submitting
-- between an admin's preview and --apply used to silently swap the claim under the approval.
-- approve_pending_binding now takes the expected superseded_count — a true monotonic revision
-- (bumped on EVERY upsert; last_submitted_at can collide since capture callers supply p_now) —
-- locks the row FOR UPDATE, and returns typed 'pending_changed' on mismatch. last_submitted_at
-- stays for display/sorting/audit only.

-- ── pending_binding: two claim shapes, strictly mutually exclusive ────────────────────────────────
alter table pending_binding alter column submitted_code drop not null;
-- Guard against counter overflow under sustained re-submission (upsert bumps it forever).
alter table pending_binding alter column superseded_count type bigint;

alter table pending_binding add column claim_source text not null default 'keyword'
  constraint pending_binding_claim_source_ck check (claim_source in ('keyword', 'liff'));
alter table pending_binding add column claimed_phone text
  constraint pending_binding_claimed_phone_ck
  check (claimed_phone is null or claimed_phone ~ '^09[0-9]{8}$');   -- canonical TW mobile only
alter table pending_binding add column claimed_name text
  constraint pending_binding_claimed_name_ck
  check (claimed_name is null or char_length(btrim(claimed_name)) between 1 and 50);

-- Strict XOR: a keyword claim carries ONLY a code; a liff claim carries ONLY phone+name.
-- Source switches must swap the whole group (the capture RPCs below enforce it; this makes any
-- future path unable to write a half-and-half row).
alter table pending_binding add constraint pending_binding_claim_shape_ck check (
  (claim_source = 'keyword' and submitted_code is not null and claimed_phone is null and claimed_name is null)
  or
  (claim_source = 'liff' and submitted_code is null and claimed_phone is not null and claimed_name is not null)
);

-- ── users.phone_number: pin the canonical representation ─────────────────────────────────────────
-- users_phone_key (0020) is a plain unique index on phone_number; until now the canonical
-- 09xxxxxxxx form was only guaranteed by the import service's TS normalization. The liff approval
-- lookup compares claimed_phone (canonical by the check above) against phone_number, so both
-- sides must speak the same representation — enforce it. Seed + import rows are already canonical.
alter table users add constraint users_phone_format_ck
  check (phone_number is null or phone_number ~ '^09[0-9]{8}$');

-- ── capture_liff_binding_claim — verified-identity claim capture (upsert in place) ───────────────
-- Same one-active-claim-per-LINE-account semantics as capture_pending_binding (0018): re-sends
-- upsert the pending row (new claim wins, superseded_count++), so the table cannot be flooded.
-- Returns counts only — never the userId, phone, or name.
create or replace function capture_liff_binding_claim(
  p_line_user_id text,
  p_phone        text,
  p_name         text,
  p_now          timestamptz
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_was_update boolean;
begin
  insert into pending_binding
    (line_user_id, submitted_code, claim_source, claimed_phone, claimed_name,
     status, last_event_type, created_at, last_submitted_at)
  values
    (p_line_user_id, null, 'liff', p_phone, btrim(p_name), 'pending', 'liff', p_now, p_now)
  on conflict (line_user_id) where status = 'pending'
  do update set
    claim_source      = 'liff',
    submitted_code    = null,                 -- XOR: switching from a keyword claim drops the code
    claimed_phone     = excluded.claimed_phone,
    claimed_name      = excluded.claimed_name,
    last_event_type   = 'liff',
    last_submitted_at = p_now,
    superseded_count  = pending_binding.superseded_count + 1
  returning (xmax <> 0) into v_was_update;

  return jsonb_build_object('captured', 1, 'superseded', coalesce(v_was_update, false));
end $$;

revoke all on function capture_liff_binding_claim(text, text, text, timestamptz) from public;
grant execute on function capture_liff_binding_claim(text, text, text, timestamptz) to service_role;

-- ── capture_pending_binding — replace (0018): keyword supersede clears the liff fields ───────────
create or replace function capture_pending_binding(
  p_line_user_id text,
  p_code         text,
  p_event_type   text,
  p_now          timestamptz
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_was_update boolean;
begin
  insert into pending_binding
    (line_user_id, submitted_code, claim_source, claimed_phone, claimed_name,
     status, last_event_type, created_at, last_submitted_at)
  values
    (p_line_user_id, p_code, 'keyword', null, null, 'pending', p_event_type, p_now, p_now)
  on conflict (line_user_id) where status = 'pending'
  do update set
    claim_source      = 'keyword',
    submitted_code    = excluded.submitted_code,
    claimed_phone     = null,                 -- XOR: switching from a liff claim drops phone/name
    claimed_name      = null,
    last_event_type   = excluded.last_event_type,
    last_submitted_at = p_now,
    superseded_count  = pending_binding.superseded_count + 1
  returning (xmax <> 0) into v_was_update;

  return jsonb_build_object('captured', 1, 'superseded', coalesce(v_was_update, false));
end $$;

-- ── approve_pending_binding — replace (0019): claim-source branch + optimistic concurrency ───────
-- Guard precedence (typed, never throws 500):
--   pending_not_found → pending_not_pending → pending_changed
--   → [keyword: code_not_found → code_expired → code_consumed | liff: phone_not_found]
--   → member_already_bound → line_id_taken → approved
-- p_expected_superseded_count is the revision the admin previewed (superseded_count is bumped on
-- every capture upsert, so it cannot collide the way a caller-supplied timestamp can). Required
-- when p_dry_run=false (mismatch → 'pending_changed'); pass null for a dry-run preview.
-- FOR UPDATE serializes concurrent approvals of the same pending row.
drop function if exists approve_pending_binding(uuid, timestamptz, boolean);
create or replace function approve_pending_binding(
  p_pending_id                uuid,
  p_expected_superseded_count bigint,
  p_now                       timestamptz,
  p_dry_run                   boolean
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_pending  pending_binding%rowtype;
  v_code     binding_codes%rowtype;
  v_user_id  uuid;
  v_existing text;
  v_updated  int;
begin
  select * into v_pending from pending_binding where id = p_pending_id for update;
  if not found then
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'pending_not_found');
  end if;

  if v_pending.status <> 'pending' then
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'pending_not_pending');
  end if;

  -- Optimistic concurrency: an apply must approve exactly the revision the admin previewed.
  if not p_dry_run then
    if p_expected_superseded_count is null
       or v_pending.superseded_count <> p_expected_superseded_count then
      return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'pending_changed');
    end if;
  end if;

  if v_pending.claim_source = 'keyword' then
    select * into v_code from binding_codes where code = v_pending.submitted_code;
    if not found then
      return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'code_not_found');
    end if;
    if v_code.expires_at < p_now then
      return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'code_expired');
    end if;
    if v_code.consumed_at is not null then
      return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'code_consumed');
    end if;
    v_user_id := v_code.user_id;
  else
    -- liff claim: the member is identified by canonical mobile phone (users_phone_key).
    select id into v_user_id from users where phone_number = v_pending.claimed_phone;
    if not found then
      return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'phone_not_found');
    end if;
  end if;

  select line_id into v_existing from users where id = v_user_id;
  if v_existing is not null then
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'member_already_bound');
  end if;

  -- Is this LINE account already bound to a (necessarily different) member?
  perform 1 from users where line_id = v_pending.line_user_id;
  if found then
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'line_id_taken');
  end if;

  if p_dry_run then
    return jsonb_build_object('approved', 0, 'would_approve', true, 'reason', 'approved');
  end if;

  -- Commit. The users write is guarded on `line_id is null`; a concurrent bind of the same
  -- line_user_id to another member surfaces as line_id_taken via the unique index, not a 500.
  begin
    update users set line_id = v_pending.line_user_id
     where id = v_user_id and line_id is null;
    get diagnostics v_updated = row_count;
  exception when unique_violation then
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'line_id_taken');
  end;
  if v_updated = 0 then
    -- Raced: member got bound between the guard and this write.
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'member_already_bound');
  end if;

  if v_pending.claim_source = 'keyword' then
    update binding_codes set
      consumed_at                 = p_now,
      consumed_pending_binding_id = v_pending.id,
      consumed_line_user_id       = v_pending.line_user_id
     where id = v_code.id;
  end if;

  update pending_binding set
    status           = 'approved',
    approved_at      = p_now,
    approved_user_id = v_user_id
   where id = v_pending.id;

  return jsonb_build_object('approved', 1, 'would_approve', true, 'reason', 'approved');
end $$;

revoke all on function approve_pending_binding(uuid, bigint, timestamptz, boolean) from public;
grant execute on function approve_pending_binding(uuid, bigint, timestamptz, boolean) to service_role;
