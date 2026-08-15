-- Wave 2C-1 (#19): admin role tiers — 系統管理員 (superadmin) / 幹事 (clerk).
--
-- Until now admin_accounts was a PEER model: every operator could disable every
-- other operator, read the whole audit log, and reach the ops internals. The church
-- will run this with several 同工 sharing the back office, so account management and
-- system maintenance need to stop being everyone's.
--
-- This migration adds the role, teaches the four role-sensitive paths to enforce it,
-- and finally fills audit_logs.actor_role_snapshot — a column that has existed since
-- 0030 and been null on every row, because there were no roles to snapshot.
--
-- ── DEPLOY ORDER: DB FIRST, then the app. This is NOT bidirectionally safe ───────
--   · migration first → OK. Existing RPC signatures are unchanged except
--     reset_admin_password (below), every existing account is backfilled to
--     superadmin, so the old app behaves exactly as before.
--   · app first       → BROKEN. The new app selects admin_accounts.role, which does
--     not exist yet, on EVERY admin request.
-- One signature DOES change: reset_admin_password 3-arg → 5-arg (it cannot write a
-- conformant admin audit row without an actor_session_id and a request_id, and the
-- old overload must be DROPPED or PostgREST's named-argument call becomes ambiguous).
-- Its compatibility window is therefore real but narrow: admin password reset ONLY,
-- for the gap between migration and app deploy. Nothing else — no cron, no member or
-- staff path, no capacity/eligibility write — is affected.
--
-- ── Why the role is resolved INSIDE the transaction, not passed in from the app ───
-- 0030's actor_role_snapshot comment asked the auth layer to pass "the role it read
-- for THIS request". Deliberate divergence, for cost: honouring it literally means
-- dropping and recreating four large SECURITY DEFINER functions (set_admin_disabled,
-- set_weekly_capacity, set_p2_eligibility, mark_p2_reviewed — 0033 alone has 15
-- append_audit_log call sites), which buys a millisecond-wide attribution difference
-- and costs a four-way PostgREST compatibility window plus wholesale body copying.
--
-- Instead:
--   · role-sensitive RPCs LOCK and read the acting account in-transaction, use that
--     value to authorise, and pass that same value to the audit writer — so the
--     snapshot is exactly the role the decision was made on.
--   · append_audit_log resolves the role itself when the caller passes null. That
--     fallback serves only the three not-yet-rewritten RPCs above. It deliberately
--     does NOT lock: those RPCs make no authorisation decision from the role, so
--     their snapshot is descriptive, and locking there would stall a role change
--     behind any long-running capacity or eligibility edit.
--   · the app's session role is used ONLY for HTTP/UI gating (403s, nav). The DB
--     never trusts a role asserted by the caller.

-- ── The role ─────────────────────────────────────────────────────────────────────
-- Two values, both implemented. triage #19 suggested reserving a third read-only
-- value now; deliberately NOT done. An enum value no gating code handles would fail
-- OPEN at every clerk-level check (which is "any authenticated admin"). Adding one
-- later is `alter type ... add value` plus compile errors at lib/adminRoles.ts's
-- capability matrix — fail loud, which is the point.
create type admin_role as enum ('superadmin', 'clerk');

-- default 'clerk': any future write path that forgets to name a role lands on the
-- least-privileged side.
alter table admin_accounts add column role admin_role not null default 'clerk';

-- ...but every EXISTING account becomes superadmin. Backfilling to clerk would strip
-- account management from everyone at once, with no UI left to grant it back (only
-- the CLI). These accounts were peers with full power; superadmin is what they had.
update admin_accounts set role = 'superadmin';

comment on column admin_accounts.role is
  'superadmin = 系統管理員 (all surfaces); clerk = 幹事 (no account management, ops, or audit log).';

-- ── audit_logs.actor_role_snapshot must stop being null for admin rows ───────────
-- NOT VALID, forever. Rows written before this migration legitimately have no role:
-- the system had no roles. Backfilling them to 'superadmin' was considered and
-- rejected for the same reason 0030 refused to backfill history at all — "converting
-- it into 'an admin did this at some point' would be fabricating evidence". null on
-- an admin row is therefore a TRUE statement, and now a provable one: after this
-- migration the writer cannot produce another.
alter table audit_logs
  add constraint audit_logs_admin_role_snapshot_ck
  check (actor_type <> 'admin' or actor_role_snapshot is not null)
  not valid;

comment on constraint audit_logs_admin_role_snapshot_ck on audit_logs is
  'Intentionally NOT VALID forever: pre-0035 admin audit rows have null snapshots because admin roles did not yet exist. New rows are enforced.';

-- ── append_audit_log: resolve the admin role, and fail loud if it cannot ─────────
-- Based on the 0032 revision (birthdate-shaped key rule). Only the role block is new.
--
-- Failing loud is correct here and is NOT the "typed return, never raise" rule for
-- governance refusals: an admin actor whose role cannot be resolved means the actor
-- id was never threaded, or points at nothing — the audit substrate's own invariant
-- is broken, not a business rule. 0030 reserves raise for exactly that, and rolling
-- the business change back with it is the right outcome.
create or replace function private.append_audit_log(
  p_actor_type          audit_actor_type,
  p_actor_id            uuid,
  p_actor_session_id    uuid,
  p_actor_role_snapshot text,
  p_action              text,
  p_entity_type         text,
  p_entity_id           uuid,
  p_weekly_event_id     uuid,
  p_request_id          uuid,
  p_result              audit_result,
  p_metadata            jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id   uuid;
  v_key  text;
  v_role text := p_actor_role_snapshot;
  -- Never acceptable in an audit row, no matter which action is writing. Store the
  -- stable ID and resolve for display instead; record that a note EXISTS, never its
  -- text. (Exact key match — 'job_name' or 'review_note_present' are unaffected.)
  v_forbidden text[] := array[
    'phone', 'phone_number', 'mobile',
    'line_id', 'line_user_id', 'line_group_id',
    'token', 'session_token', 'binding_code',
    'password', 'password_hash', 'pin', 'pin_hash',
    'plate', 'license_plate',
    'name', 'display_name',
    'note', 'review_note', 'reason_text', 'remarks',
    'birthdate', 'address', 'email'
  ];
begin
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'append_audit_log: metadata must be a JSON object';
  end if;

  if pg_column_size(p_metadata) > 2048 then
    raise exception 'append_audit_log: metadata too large (% bytes)', pg_column_size(p_metadata);
  end if;

  for v_key in select jsonb_object_keys(p_metadata) loop
    if jsonb_typeof(p_metadata -> v_key) not in ('string', 'number', 'boolean', 'null') then
      raise exception
        'append_audit_log: metadata must be flat — key % holds a %',
        v_key, jsonb_typeof(p_metadata -> v_key);
    end if;
    if v_key = any(v_forbidden) then
      raise exception 'append_audit_log: metadata key % is never allowed in an audit row', v_key;
    end if;
    -- Wave 2B-2a (#10): catches what the exact list cannot see — p2_child_birthdate,
    -- child_birthdate, youngest_child_birthdate, dependent_birthdate, *_birthdate_from/_to,
    -- birth_date, dob. A boolean passes so presence stays reportable.
    if v_key ~ '(birth_?date)|((^|_)dob($|_))'
       and jsonb_typeof(p_metadata -> v_key) <> 'boolean' then
      raise exception
        'append_audit_log: key % is birthdate-shaped and holds a %; a date of birth must never be '
        'stored in an append-only audit row — record presence as a boolean instead',
        v_key, jsonb_typeof(p_metadata -> v_key);
    end if;
  end loop;

  -- Wave 2C-1 (#19). Unlocked on purpose — see this file's header. Callers that
  -- authorise on the role pass it explicitly and never reach this branch.
  if p_actor_type = 'admin' and v_role is null then
    select role::text into v_role from admin_accounts where id = p_actor_id;
    if v_role is null then
      raise exception
        'append_audit_log: admin actor % has no resolvable role — the actor id was not threaded, '
        'or points at no account; refusing to write an admin audit row without a role snapshot',
        coalesce(p_actor_id::text, '<null>');
    end if;
  end if;

  insert into audit_logs (
    actor_type, actor_id, actor_session_id, actor_role_snapshot,
    action, entity_type, entity_id, weekly_event_id,
    request_id, result, metadata_redacted
  ) values (
    p_actor_type, p_actor_id, p_actor_session_id, v_role,
    p_action, p_entity_type, p_entity_id, p_weekly_event_id,
    p_request_id, p_result, p_metadata
  )
  returning id into v_id;

  return v_id;
end $$;

-- create or replace preserves the existing grants (EXECUTE to nobody), but re-assert
-- rather than rely on that: this function is the only path into audit_logs.
revoke all on function private.append_audit_log(
  audit_actor_type, uuid, uuid, text, text, text, uuid, uuid, uuid, audit_result, jsonb
) from public, anon, authenticated, service_role;

-- ── One lock for every admin-account mutation ────────────────────────────────────
-- It exists for two distinct reasons, and BOTH are load-bearing:
--
-- (1) The invariant: at least one row with disabled_at is null AND role = 'superadmin'
--     must exist. 0026/0030 serialized only the disable path, under
--     hashtext('admin_disable_guard'). With roles that name is too narrow AND the
--     single-path guard is unsound: A demoting superadmin X while B disables
--     superadmin Y would have each transaction see the other's account still active,
--     both succeed, and leave zero.
--
-- (2) Deadlock. Every one of these RPCs locks the ACTING row (FOR SHARE) and then a
--     TARGET row (FOR UPDATE) — two admin_accounts rows, in an order chosen by whoever
--     is being acted on. Two such transactions with mirrored actor/target therefore
--     form a cycle:
--         A resets B's password : share(A) → wants update(B)
--         B resets A's password : share(B) → wants update(A)
--     Postgres breaks it with 40P01 and the API answers 500. Not corruption, but a
--     reproducible failure of an ordinary admin action. Taking this lock FIRST — before
--     any row lock — makes the pair strictly sequential, so the cycle cannot form. The
--     alternative (locking the two rows in a canonical id order) is more machinery for
--     a rarer path and one more thing to get wrong.
--
-- ⇒ RULE: every RPC that mutates admin_accounts takes this lock at its entry point,
--   unconditionally — including ones that cannot shrink the superadmin set, because
--   reason (2) applies to them too. Applies to set_admin_disabled and
--   reset_admin_password (here) and set_admin_role + create_admin_account (0036). These
--   are rare, human-driven operations; serializing all of them costs nothing and
--   removes a whole category of reasoning error.
--
-- (Advisory locks are transient, so renaming the key is safe — there is no persisted
-- state and set_admin_disabled was its only holder.)

-- ── set_admin_disabled — signature unchanged, guard now role-aware ───────────────
-- The acting-account block below is the TEMPLATE shared verbatim by every
-- role-sensitive RPC. Two things about it are load-bearing:
--   · disabled_at is NOT in the WHERE clause. Filtering there would collapse "no such
--     account" and "account is disabled" into one `not found`, and would also hide
--     the disabled actor's role — which is exactly the value its denial row needs.
--   · FOR SHARE, so a concurrent set_admin_role demoting the actor must wait for this
--     transaction. Authorisation, audit snapshot and commit then agree.
create or replace function set_admin_disabled(
  p_target_id         uuid,
  p_acting_admin_id   uuid,
  p_acting_session_id uuid,
  p_disabled          boolean,
  p_now               timestamptz,
  p_request_id        uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acting_role        admin_role;
  v_acting_disabled_at timestamptz;
  v_disabled_at        timestamptz;
  v_target_role        admin_role;
  v_state_changed      boolean := false;
  v_action             text := case when p_disabled then 'admin_account.disable'
                                                    else 'admin_account.enable' end;
begin
  perform pg_advisory_xact_lock(hashtext('active_superadmin_invariant'));

  select role, disabled_at into v_acting_role, v_acting_disabled_at
    from admin_accounts where id = p_acting_admin_id for share;
  if not found then
    -- No account means no role, so no conformant admin audit row can exist for it.
    -- It is also a bad request, not a governed refusal — 0030: not_found is not audited.
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_not_found');
  end if;

  if v_acting_disabled_at is not null then
    -- Cannot normally happen: adminAuth re-reads disabled_at and deletes the session on
    -- every request. It is the race between that check and this transaction, and a
    -- disabled account still acting is worth a row.
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'admin_account', p_target_id, null,
      p_request_id, 'denied',
      jsonb_build_object('reason', 'acting_admin_disabled')
    );
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_disabled');
  end if;

  if v_acting_role <> 'superadmin' then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'admin_account', p_target_id, null,
      p_request_id, 'denied',
      jsonb_build_object('reason', 'forbidden_role')
    );
    return jsonb_build_object('ok', false, 'reason', 'forbidden_role');
  end if;

  if p_target_id = p_acting_admin_id then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'admin_account', p_target_id, null,
      p_request_id, 'denied',
      jsonb_build_object('reason', 'cannot_target_self')
    );
    return jsonb_build_object('ok', false, 'reason', 'cannot_target_self');
  end if;

  select disabled_at, role into v_disabled_at, v_target_role
    from admin_accounts where id = p_target_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if p_disabled then
    -- Only a currently-active SUPERADMIN target counts against the invariant. Disabling
    -- the last clerk is fine, and re-disabling an already-disabled account is a no-op
    -- on that check.
    --
    -- ⚠️ As of this migration this guard is UNREACHABLE through this RPC, and that is a
    -- consequence worth stating rather than discovering later. The acting account is now
    -- verified to be an ACTIVE SUPERADMIN (locked above) and self-target is refused, so
    -- the actor is always an active superadmin other than the target — the `exists`
    -- below always finds them. Before 0035 the guard was reachable only because nothing
    -- checked that the acting admin existed at all: passing a fictional actor id made
    -- the target look like the last one standing.
    --
    -- It stays because it is the invariant's last line of defence for any FUTURE path
    -- that can shrink the set without an actor who survives it: a self-demotion, a hard
    -- delete, a maintenance script with no session. Add one of those and this is what
    -- stops it. The concurrency test in tests/integration/admin-roles.db.test.ts pins
    -- the structural property that currently makes it moot.
    if v_disabled_at is null then
      if v_target_role = 'superadmin' and not exists (
        select 1 from admin_accounts
         where disabled_at is null and role = 'superadmin' and id <> p_target_id
      ) then
        perform private.append_audit_log(
          'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
          v_action, 'admin_account', p_target_id, null,
          p_request_id, 'denied',
          jsonb_build_object('reason', 'last_active_superadmin')
        );
        return jsonb_build_object('ok', false, 'reason', 'last_active_superadmin');
      end if;
      update admin_accounts set disabled_at = p_now where id = p_target_id;
      v_state_changed := true;
    end if;
  else
    update admin_accounts set disabled_at = null where id = p_target_id;
    v_state_changed := v_disabled_at is not null;
  end if;

  delete from admin_sessions where admin_id = p_target_id;

  -- Written even when state_changed is false, and that is deliberate. A repeat
  -- disable looks like a no-op but is not one: the session delete above runs
  -- UNCONDITIONALLY (see 0026 — enabling revokes sessions too, closing a
  -- stale-cookie-revival hazard). Suppressing this row to avoid resubmit noise
  -- would hide a real session revocation. state_changed lets the viewer
  -- de-emphasise it instead.
  perform private.append_audit_log(
    'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
    v_action, 'admin_account', p_target_id, null,
    p_request_id, 'success',
    jsonb_build_object('disabled_to', p_disabled, 'state_changed', v_state_changed)
  );

  return jsonb_build_object('ok', true);
end $$;

revoke all on function set_admin_disabled(uuid, uuid, uuid, boolean, timestamptz, uuid) from public;
grant execute on function set_admin_disabled(uuid, uuid, uuid, boolean, timestamptz, uuid) to service_role;

-- ── reset_admin_password — role guard AND, at last, an audit row on success ──────
-- Signature changes (3 args → 5): a conformant admin audit row needs an
-- actor_session_id (audit_logs_actor_shape_ck) and a request_id (NOT NULL), and
-- neither could be reached from the old signature. The old overload is DROPPED, not
-- left alongside — two overloads would make the PostgREST named-argument call
-- ambiguous. See this file's header for the (narrow) compatibility window.
--
-- Auditing the SUCCESS path is not scope creep: this function is already being
-- rebuilt for the role guard, and shipping the guard alone would produce a broken
-- record — a clerk's refusal logged, a superadmin's actual credential reset silent.
-- Metadata carries no password, hash, username or display name (the writer's denylist
-- would reject the last two anyway); the target is identified by entity_id.
drop function reset_admin_password(uuid, uuid, text);

create function reset_admin_password(
  p_target_id         uuid,
  p_acting_admin_id   uuid,
  p_acting_session_id uuid,
  p_password_hash     text,
  p_request_id        uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acting_role        admin_role;
  v_acting_disabled_at timestamptz;
  v_username           text;
  v_disabled_at        timestamptz;
  v_action             text := 'admin_account.password_reset';
begin
  -- Yes, even though a password reset cannot shrink the active-superadmin set: it locks
  -- an acting row and then a target row, so without this it deadlocks against any other
  -- account mutation with mirrored actor/target (see reason (2) above).
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
      p_request_id, 'denied',
      jsonb_build_object('reason', 'acting_admin_disabled')
    );
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_disabled');
  end if;

  if v_acting_role <> 'superadmin' then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'admin_account', p_target_id, null,
      p_request_id, 'denied',
      jsonb_build_object('reason', 'forbidden_role')
    );
    return jsonb_build_object('ok', false, 'reason', 'forbidden_role');
  end if;

  if p_target_id = p_acting_admin_id then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'admin_account', p_target_id, null,
      p_request_id, 'denied',
      jsonb_build_object('reason', 'cannot_target_self')
    );
    return jsonb_build_object('ok', false, 'reason', 'cannot_target_self');
  end if;

  select username, disabled_at into v_username, v_disabled_at
    from admin_accounts where id = p_target_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Receives only the ALREADY-HASHED password (server/http/pinHash.ts scrypt, enforced
  -- by admin_accounts_password_hash_ck) — this never sees or returns plaintext.
  -- Leaves disabled_at untouched: resetting a disabled account's password does not
  -- re-enable it.
  update admin_accounts set
    password_hash   = p_password_hash,
    failed_attempts = 0,
    locked_at       = null
   where id = p_target_id;

  delete from admin_sessions where admin_id = p_target_id;

  perform private.append_audit_log(
    'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
    v_action, 'admin_account', p_target_id, null,
    p_request_id, 'success',
    jsonb_build_object('sessions_revoked', true, 'target_disabled', v_disabled_at is not null)
  );

  return jsonb_build_object('ok', true, 'username', v_username, 'disabled', v_disabled_at is not null);
end $$;

revoke all on function reset_admin_password(uuid, uuid, uuid, text, uuid) from public;
grant execute on function reset_admin_password(uuid, uuid, uuid, text, uuid) to service_role;
