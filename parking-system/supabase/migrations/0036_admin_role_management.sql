-- Wave 2C-2 (#19): the account-management writes the Admin UI needs — create an
-- operator, change an operator's role, and revoke an operator's sessions — each as a
-- single audited SECURITY DEFINER RPC.
--
-- 2C-1 (0035) shipped the role tier and gated reads, but left NO way to create a 幹事:
-- the CLI only makes superadmins (it is the recovery path), and there was no UI to
-- create anyone. This migration is what makes the tier usable. It also closes the last
-- 2C-1 gap: session revocation was a bare repository DELETE — no RPC, no audit — and is
-- now an audited RPC like its neighbours.
--
-- ── DEPLOY: additive to signatures, but still DB-FIRST ───────────────────────────
-- This migration REMOVES or CHANGES no existing RPC, so a migration-first middle stage
-- does not break the old app (unlike 0035, which changed reset_admin_password). But the
-- new app calls the three RPCs below, which do not exist until this lands — so app-first
-- makes account creation / role change / session revoke fail. Order stays fixed:
-- migration → db:verify:remote → app → smoke (prod-deploy-runbook.md §1.5).
--
-- ── Rules inherited from 0035, not re-derived here ───────────────────────────────
-- 1. Every account-management RPC with an acting-admin context takes the SAME advisory
--    lock at entry, BEFORE any row lock:
--        pg_advisory_xact_lock(hashtext('active_superadmin_invariant'))
--    Two reasons (0035 header): the active-superadmin invariant, and deadlock — an RPC
--    that locks the acting row (FOR SHARE) then a target row (FOR UPDATE) can, mirrored
--    across two backends, form a 40P01 cycle. set_admin_role and revoke_admin_sessions
--    are exactly that shape. create_admin_account has no target row and so cannot form
--    that cycle; it still takes the lock, purely for one consistent account-management
--    serialization policy — do NOT describe it as a deadlock fix.
--    (apply_admin_login_failure, 0025, also updates admin_accounts but is a single-row
--    login counter with no acting/target pair — it does not take this lock.)
-- 2. Acting-account template: read role AND disabled_at (neither in the WHERE, or "no
--    such account" and "account disabled" collapse into one not-found and the disabled
--    actor's role is unreadable), FOR SHARE. acting_admin_not_found → no audit (no
--    account = no role, and it is a bad request); acting_admin_disabled / forbidden_role
--    → audited 'denied'.
-- 3. The role is read here, never asserted by the caller, and the value used to
--    authorise is the SAME value handed to the audit writer.
-- 4. Governance refusals are TYPED RETURNS, never raise (a raise rolls back the very row
--    that records the refusal).
-- 5. last_active_superadmin stays enforced but is unreachable through these RPCs (the
--    actor must itself be an active superadmin and cannot target itself, so one always
--    survives) — kept for a future path that can shrink the set without a surviving actor.
-- 6. self-target is checked BEFORE the target row lock: it only compares the acting id
--    to a known value, needs no target row, and avoids a FOR SHARE→FOR UPDATE upgrade on
--    the actor's own row.
-- 7. self-target is an AUDITED governance refusal, written by the RPC. The service layer
--    no longer short-circuits it (that would make the same refusal audited or not by
--    entry point). This slice also removes that short-circuit from 0035's set_admin_disabled
--    / reset_admin_password service wrappers so all four operations behave alike.

-- ── set_admin_role — change another admin's tier ─────────────────────────────────
create function set_admin_role(
  p_target_id         uuid,
  p_acting_admin_id   uuid,
  p_acting_session_id uuid,
  p_role              admin_role,
  p_request_id        uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acting_role        admin_role;
  v_acting_disabled_at timestamptz;
  v_target_role        admin_role;
  v_target_disabled_at timestamptz;
  v_action             text := 'admin_account.role_change';
begin
  perform pg_advisory_xact_lock(hashtext('active_superadmin_invariant'));

  -- Acting-account template (rule 2).
  select role, disabled_at into v_acting_role, v_acting_disabled_at
    from admin_accounts where id = p_acting_admin_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_not_found');
  end if;
  if v_acting_disabled_at is not null then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'admin_account', p_target_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'acting_admin_disabled'));
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_disabled');
  end if;
  if v_acting_role <> 'superadmin' then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'admin_account', p_target_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'forbidden_role'));
    return jsonb_build_object('ok', false, 'reason', 'forbidden_role');
  end if;

  -- self-target BEFORE the target lock (rule 6). Blocks both self-promotion and
  -- self-demotion; audited (rule 7).
  if p_target_id = p_acting_admin_id then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'admin_account', p_target_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'cannot_target_self'));
    return jsonb_build_object('ok', false, 'reason', 'cannot_target_self');
  end if;

  select role, disabled_at into v_target_role, v_target_disabled_at
    from admin_accounts where id = p_target_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- A genuinely inert no-op: same role in, same role out. Write nothing and revoke
  -- nothing — unlike set_admin_disabled, which is never inert because it always deletes
  -- sessions (0035). Returning it as changed:false lets the UI say "no change" honestly.
  if v_target_role = p_role then
    return jsonb_build_object('ok', true, 'changed', false, 'role', p_role);
  end if;

  -- Demoting the last active superadmin (rule 5): unreachable here — the actor is an
  -- active superadmin other than the target, so one always remains — but kept as the
  -- invariant's defence for any future caller.
  if v_target_role = 'superadmin' and p_role <> 'superadmin'
     and not exists (
       select 1 from admin_accounts
        where disabled_at is null and role = 'superadmin' and id <> p_target_id
     ) then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'admin_account', p_target_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'last_active_superadmin'));
    return jsonb_build_object('ok', false, 'reason', 'last_active_superadmin');
  end if;

  update admin_accounts set role = p_role where id = p_target_id;

  -- The authority is the per-request role re-read (adminAuth), so a demotion already
  -- bites on the target's next request. Deleting sessions makes the change visible now
  -- rather than leaving a rendered shell on the stale role (precedent: 0026).
  delete from admin_sessions where admin_id = p_target_id;

  -- actor_role_snapshot is the ACTOR's role (superadmin); from_role/to_role describe the
  -- TARGET. Do not conflate them.
  perform private.append_audit_log(
    'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
    v_action, 'admin_account', p_target_id, null,
    p_request_id, 'success',
    jsonb_build_object('from_role', v_target_role::text, 'to_role', p_role::text));

  return jsonb_build_object('ok', true, 'changed', true, 'role', p_role);
end $$;

revoke all on function set_admin_role(uuid, uuid, uuid, admin_role, uuid) from public;
grant execute on function set_admin_role(uuid, uuid, uuid, admin_role, uuid) to service_role;

-- ── create_admin_account — provision another operator ────────────────────────────
-- Receives the ALREADY-HASHED password (scrypt, enforced by admin_accounts_password_hash_ck);
-- never sees or returns plaintext. Username/display-name normalization and password
-- strength live in the app (lib/adminAccountInput.ts, shared with the CLI); the DB's
-- username check + unique index are the final authority.
create function create_admin_account(
  p_username          text,
  p_password_hash     text,
  p_display_name      text,
  p_role              admin_role,
  p_acting_admin_id   uuid,
  p_acting_session_id uuid,
  p_request_id        uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acting_role        admin_role;
  v_acting_disabled_at timestamptz;
  v_id                 uuid;
  v_username           text;
  v_display_name       text;
  v_created_at         timestamptz;
  v_disabled_at        timestamptz;
  v_locked_at          timestamptz;
  v_constraint         text;
  v_action             text := 'admin_account.create';
begin
  -- Takes the lock for a consistent account-management serialization policy, NOT to
  -- prevent a deadlock: a create has no target row and cannot form the actor/target
  -- cycle (rule 1). entity_id is null on the acting-guard rows — the account does not
  -- exist yet.
  perform pg_advisory_xact_lock(hashtext('active_superadmin_invariant'));

  select role, disabled_at into v_acting_role, v_acting_disabled_at
    from admin_accounts where id = p_acting_admin_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_not_found');
  end if;
  if v_acting_disabled_at is not null then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'admin_account', null, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'acting_admin_disabled'));
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_disabled');
  end if;
  if v_acting_role <> 'superadmin' then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'admin_account', null, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'forbidden_role'));
    return jsonb_build_object('ok', false, 'reason', 'forbidden_role');
  end if;

  -- The exception block wraps ONLY the INSERT, and matches the constraint by name: a
  -- username collision is a typed 'username_taken' (a bad request, not audited), but any
  -- OTHER failure — a future constraint, or the audit write below hitting request_id
  -- NOT NULL — must propagate and roll the whole thing back, never be swallowed as 409.
  begin
    insert into admin_accounts (username, password_hash, display_name, role)
    values (p_username, p_password_hash, p_display_name, p_role)
    returning id, username, display_name, created_at, disabled_at, locked_at
      into v_id, v_username, v_display_name, v_created_at, v_disabled_at, v_locked_at;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'admin_accounts_username_key' then
      return jsonb_build_object('ok', false, 'reason', 'username_taken');
    end if;
    raise;
  end;

  perform private.append_audit_log(
    'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
    v_action, 'admin_account', v_id, null,
    p_request_id, 'success', jsonb_build_object('role', p_role::text));

  -- Return the DB-canonical row (normalized username/display_name) so the route never
  -- reinterprets input; the caller derives status from disabled_at/locked_at.
  return jsonb_build_object(
    'ok', true,
    'id', v_id,
    'username', v_username,
    'display_name', v_display_name,
    'role', p_role::text,
    'created_at', v_created_at,
    'disabled_at', v_disabled_at,
    'locked_at', v_locked_at);
end $$;

revoke all on function create_admin_account(text, text, text, admin_role, uuid, uuid, uuid) from public;
grant execute on function create_admin_account(text, text, text, admin_role, uuid, uuid, uuid) to service_role;

-- ── revoke_admin_sessions — force-log-out another operator, now audited ──────────
-- 2C-1 left this as a plain repository DELETE (no RPC, no audit). It is now an audited
-- RPC so the account-management surface records all three writes uniformly.
create function revoke_admin_sessions(
  p_target_id         uuid,
  p_acting_admin_id   uuid,
  p_acting_session_id uuid,
  p_request_id        uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acting_role        admin_role;
  v_acting_disabled_at timestamptz;
  v_sessions_revoked   int;
  v_action             text := 'admin_account.session_revoke';
begin
  perform pg_advisory_xact_lock(hashtext('active_superadmin_invariant'));

  select role, disabled_at into v_acting_role, v_acting_disabled_at
    from admin_accounts where id = p_acting_admin_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_not_found');
  end if;
  if v_acting_disabled_at is not null then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'admin_account', p_target_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'acting_admin_disabled'));
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_disabled');
  end if;
  if v_acting_role <> 'superadmin' then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'admin_account', p_target_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'forbidden_role'));
    return jsonb_build_object('ok', false, 'reason', 'forbidden_role');
  end if;

  if p_target_id = p_acting_admin_id then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'admin_account', p_target_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'cannot_target_self'));
    return jsonb_build_object('ok', false, 'reason', 'cannot_target_self');
  end if;

  -- Lock the target so a concurrent disable/role change against the same account
  -- serializes behind this (they share the advisory lock too, but this keeps the row
  -- read honest). not_found is a bad request, not audited.
  perform 1 from admin_accounts where id = p_target_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Count via ROW_COUNT, not RETURNING INTO: a multi-row RETURNING assigned to a scalar
  -- takes only the first row and yields no count.
  delete from admin_sessions where admin_id = p_target_id;
  get diagnostics v_sessions_revoked = row_count;

  -- Written even when zero sessions were deleted, unlike an inert no-op: this is the
  -- INTENT of a security action, and 0 is itself the answer (the target was not logged
  -- in). An operator who clicks and finds nothing in the log is the worse outcome.
  perform private.append_audit_log(
    'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
    v_action, 'admin_account', p_target_id, null,
    p_request_id, 'success', jsonb_build_object('sessions_revoked', v_sessions_revoked));

  return jsonb_build_object('ok', true, 'sessions_revoked', v_sessions_revoked);
end $$;

revoke all on function revoke_admin_sessions(uuid, uuid, uuid, uuid) from public;
grant execute on function revoke_admin_sessions(uuid, uuid, uuid, uuid) to service_role;
