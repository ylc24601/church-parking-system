-- Phase 8 Slice 3: Admin UI — admin account management (disable/enable, password
-- reset, session revocation). This is an offboarding security feature, so the two
-- state-changing operations are each a SINGLE atomic RPC rather than a sequence of
-- repository calls — a half-completed sequence here (e.g. password changed but the
-- old sessions not revoked) is a live credential/session inconsistency, not just a
-- UX glitch.
--
-- Both RPCs guard "acting admin cannot target themselves" a second time inside the
-- transaction (the service and route already check this) so no future caller can
-- bypass it by calling the RPC directly.

-- ── set_admin_disabled — atomic disable/enable + last-active guard + session revoke ─
-- Idempotent: disabling an already-disabled account (or enabling an already-enabled
-- one) still returns ok and still clears sessions, without re-running the
-- last-active check (which only applies when disabling a currently-active admin).
--
-- Enabling ALSO revokes sessions: this is the fix for a real hazard — if a prior
-- disable's session deletion missed a row (partial failure, or a device that never
-- made a request while the account was disabled), a bare `disabled_at = null` would
-- let that stale opaque-token cookie become valid again. Re-enabling always forces
-- a fresh login.
--
-- Last-active guard runs INSIDE this transaction, serialized by a session-scoped
-- advisory lock (all disable/enable calls contend on the same lock key), so two
-- admins racing to disable each other cannot both succeed and leave zero enabled
-- admins — at most one of the two calls disables; the other sees last_active_admin.
create or replace function set_admin_disabled(
  p_target_id        uuid,
  p_acting_admin_id  uuid,
  p_disabled         boolean,
  p_now              timestamptz
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_disabled_at timestamptz;
begin
  if p_target_id = p_acting_admin_id then
    return jsonb_build_object('ok', false, 'reason', 'cannot_target_self');
  end if;

  -- Serializes concurrent disable/enable calls against each other so the
  -- last-active count below is evaluated against a consistent view.
  perform pg_advisory_xact_lock(hashtext('admin_disable_guard'));

  select disabled_at into v_disabled_at
    from admin_accounts where id = p_target_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if p_disabled then
    -- Only a currently-active target counts against the last-active invariant;
    -- re-disabling an already-disabled account is a no-op on that check.
    if v_disabled_at is null then
      if not exists (
        select 1 from admin_accounts
         where disabled_at is null and id <> p_target_id
      ) then
        return jsonb_build_object('ok', false, 'reason', 'last_active_admin');
      end if;
      update admin_accounts set disabled_at = p_now where id = p_target_id;
    end if;
  else
    update admin_accounts set disabled_at = null where id = p_target_id;
  end if;

  delete from admin_sessions where admin_id = p_target_id;

  return jsonb_build_object('ok', true);
end $$;

revoke all on function set_admin_disabled(uuid, uuid, boolean, timestamptz) from public;
grant execute on function set_admin_disabled(uuid, uuid, boolean, timestamptz) to service_role;

-- ── reset_admin_password — atomic password reset + failure/lock clear + session revoke
-- Receives only the ALREADY-HASHED password (server/http/pinHash.ts scrypt, enforced
-- by admin_accounts_password_hash_ck) — the RPC never sees or returns plaintext.
-- Leaves disabled_at untouched: resetting a disabled account's password does not
-- re-enable it (an operator must separately call set_admin_disabled to enable).
create or replace function reset_admin_password(
  p_target_id        uuid,
  p_acting_admin_id  uuid,
  p_password_hash    text
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_username    text;
  v_disabled_at timestamptz;
begin
  if p_target_id = p_acting_admin_id then
    return jsonb_build_object('ok', false, 'reason', 'cannot_target_self');
  end if;

  select username, disabled_at into v_username, v_disabled_at
    from admin_accounts where id = p_target_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  update admin_accounts set
    password_hash   = p_password_hash,
    failed_attempts = 0,
    locked_at       = null
   where id = p_target_id;

  delete from admin_sessions where admin_id = p_target_id;

  return jsonb_build_object('ok', true, 'username', v_username, 'disabled', v_disabled_at is not null);
end $$;

revoke all on function reset_admin_password(uuid, uuid, text) from public;
grant execute on function reset_admin_password(uuid, uuid, text) to service_role;
