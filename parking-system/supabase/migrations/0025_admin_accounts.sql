-- Phase 8 Slice 1: Admin UI — per-admin accounts, hashed-token sessions, and the
-- binding-decision audit trail.
--
-- admin_accounts is a DEDICATED operator credential table (per-admin username +
-- scrypt password), deliberately separate from users.role='admin': member accounts
-- and back-office operator accounts have different lifecycles, auth methods, and
-- audit responsibilities. Sessions mirror member_sessions (0021): the cookie carries
-- a raw random token, only its sha256 lands in token_hash.
--
-- approve/reject_pending_binding gain a DEFAULTED p_admin_id so the Admin UI records
-- who decided (pending_binding.decided_by_admin_id) while the existing binding:approve
-- / binding:reject CLIs keep working unchanged (their decisions record null).

-- ── admin_accounts ────────────────────────────────────────────────────────────────
create table admin_accounts (
  id              uuid        primary key default gen_random_uuid(),
  -- Stored lowercase (service normalizes trim+lowercase before lookup); the check
  -- makes the invariant readable from the schema itself.
  username        text        not null
    constraint admin_accounts_username_ck
    check (username = lower(username) and username ~ '^[a-z0-9_.-]{3,32}$'),
  -- scrypt$<saltHex>$<hashHex> (server/http/pinHash.ts). The prefix check is a
  -- minimal guard against a future path accidentally writing plaintext here.
  password_hash   text        not null
    constraint admin_accounts_password_hash_ck
    check (password_hash like 'scrypt$%'),
  display_name    text
    constraint admin_accounts_display_name_ck
    check (display_name is null or char_length(btrim(display_name)) between 1 and 80),
  failed_attempts int         not null default 0,
  locked_at       timestamptz,
  disabled_at     timestamptz,   -- deactivate without delete; live sessions die on next request
  created_at      timestamptz not null default now()
);

create unique index admin_accounts_username_key on admin_accounts (username);

-- Created after 0004's one-time blanket grant → privileges must be explicit.
-- RLS deny-all + service_role (which bypasses RLS) is the only DB principal.
alter table admin_accounts enable row level security;
revoke all on admin_accounts from anon, authenticated;
grant select, insert, update, delete on admin_accounts to service_role;

-- ── admin_sessions (mirror of member_sessions, 0021) ──────────────────────────────
create table admin_sessions (
  id         uuid        primary key default gen_random_uuid(),
  admin_id   uuid        not null references admin_accounts(id) on delete cascade,
  token_hash text        not null unique,   -- sha256 hex of the cookie token; raw token is never stored
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint admin_sessions_expiry_after_creation check (expires_at > created_at)
);

-- Lazy cleanup of an admin's expired sessions happens at login.
create index admin_sessions_admin_idx on admin_sessions (admin_id);

alter table admin_sessions enable row level security;
revoke all on admin_sessions from anon, authenticated;
grant select, insert, update, delete on admin_sessions to service_role;

-- ── apply_admin_login_failure — atomic failure counter with lock-cycle semantics ──
-- Unlike apply_staff_pin_failure (0010), the lock window is evaluated INSIDE the
-- atomic update so an expired lock starts a NEW round instead of compounding:
--   · lock still active  → no-op (don't extend locked_at — repeated requests must
--     not be able to keep an account locked forever)
--   · lock expired       → this failure counts as round 1 (failed_attempts = 1)
--   · no lock            → increment; reaching p_threshold sets locked_at = p_now
-- Thresholds come from the TS single-source (ADMIN_LOGIN_MAX_ATTEMPTS /
-- ADMIN_LOGIN_LOCK_MINUTES in lib/allocation/rules.ts), passed in as parameters.
create or replace function apply_admin_login_failure(
  p_id           uuid,
  p_now          timestamptz,
  p_threshold    int,
  p_lock_minutes int
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_failed int; v_locked timestamptz;
begin
  update admin_accounts
     set failed_attempts = case
           -- lock still active: leave the counter alone
           when locked_at is not null and p_now < locked_at + make_interval(mins => p_lock_minutes)
             then failed_attempts
           -- lock expired: new round, this failure is #1
           when locked_at is not null
             then 1
           else failed_attempts + 1
         end,
         locked_at = case
           when locked_at is not null and p_now < locked_at + make_interval(mins => p_lock_minutes)
             then locked_at
           when locked_at is not null
             then case when p_threshold <= 1 then p_now else null end
           else case when failed_attempts + 1 >= p_threshold then p_now else locked_at end
         end
   where id = p_id
   returning failed_attempts, locked_at into v_failed, v_locked;

  if not found then
    return null;
  end if;
  return jsonb_build_object('failed_attempts', v_failed, 'locked_at', v_locked);
end $$;

revoke all on function apply_admin_login_failure(uuid, timestamptz, int, int) from public;
grant execute on function apply_admin_login_failure(uuid, timestamptz, int, int) to service_role;

-- ── pending_binding: who decided (approver/rejecter audit) ────────────────────────
-- approved_user_id (0019) stores the BOUND MEMBER, not the decider. CLI decisions
-- stay null ("CLI / unattributed").
alter table pending_binding add column decided_by_admin_id uuid references admin_accounts(id);

-- Bound the operator-supplied rejection reason at the schema level too (the service
-- caps it at 200 code points; char_length counts the same units). No deployed
-- environment predates this migration, so there are no legacy over-long values —
-- re-validate before applying if that ever changes.
alter table pending_binding add constraint pending_binding_rejected_reason_len_ck
  check (rejected_reason is null or char_length(rejected_reason) between 1 and 200);

-- ── approve_pending_binding: 4-arg → 5-arg (defaulted p_admin_id) ─────────────────
-- MUST drop first: create-or-replace with an extra arg would leave BOTH overloads
-- and make PostgREST named-argument calls ambiguous.
drop function if exists approve_pending_binding(uuid, bigint, timestamptz, boolean);
create or replace function approve_pending_binding(
  p_pending_id                uuid,
  p_expected_superseded_count bigint,
  p_now                       timestamptz,
  p_dry_run                   boolean,
  p_admin_id                  uuid default null
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

  -- Only this committed path records the decider — dry-runs and every guarded
  -- rejection above write nothing.
  update pending_binding set
    status              = 'approved',
    approved_at         = p_now,
    approved_user_id    = v_user_id,
    decided_by_admin_id = p_admin_id
   where id = v_pending.id;

  return jsonb_build_object('approved', 1, 'would_approve', true, 'reason', 'approved');
end $$;

revoke all on function approve_pending_binding(uuid, bigint, timestamptz, boolean, uuid) from public;
grant execute on function approve_pending_binding(uuid, bigint, timestamptz, boolean, uuid) to service_role;

-- ── reject_pending_binding: 3-arg → 4-arg (defaulted p_admin_id) ──────────────────
-- Also fixes a latent race the 0019 version had: its status read took no lock and its
-- UPDATE had no status guard, so a reject racing a concurrent approve could overwrite
-- a just-approved row back to 'rejected' (users.line_id written, audit says rejected).
-- FOR UPDATE serializes against approve_pending_binding's row lock — the late reader
-- then sees the final status and returns pending_not_pending.
drop function if exists reject_pending_binding(uuid, text, timestamptz);
create or replace function reject_pending_binding(
  p_pending_id uuid,
  p_reason     text,
  p_now        timestamptz,
  p_admin_id   uuid default null
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_status text;
begin
  select status into v_status from pending_binding where id = p_pending_id for update;
  if not found then
    return jsonb_build_object('rejected', 0, 'reason', 'pending_not_found');
  end if;
  if v_status <> 'pending' then
    return jsonb_build_object('rejected', 0, 'reason', 'pending_not_pending');
  end if;

  update pending_binding set
    status              = 'rejected',
    rejected_at         = p_now,
    rejected_reason     = p_reason,
    decided_by_admin_id = p_admin_id
   where id = p_pending_id;

  return jsonb_build_object('rejected', 1, 'reason', 'rejected');
end $$;

revoke all on function reject_pending_binding(uuid, text, timestamptz, uuid) from public;
grant execute on function reject_pending_binding(uuid, text, timestamptz, uuid) to service_role;
