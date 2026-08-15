-- Wave 2A-1 (#15): the audit substrate — an append-only governance log, written
-- inside the business transaction, that #10 (P2 review) and #14A (capacity) will
-- reuse. This migration reshapes audit_logs, adds the private writer, locks the
-- table down against the application principal, and converts ONE exemplar RPC
-- (set_admin_disabled) to prove the whole chain end to end.
--
-- ── Why audit_logs is being rebuilt rather than extended ─────────────────────────
-- The table has existed since 0003 with ZERO insert path — nothing in the codebase
-- has ever written a row (its only other reference is `enable row level security`
-- in 0004). It is empty scaffolding, so a reshape costs nothing. The guard below
-- turns that claim into an assertion rather than an assumption.
--
-- ── DEPLOY: this migration is NOT additive — it has a compatibility window ───────
-- set_admin_disabled's signature changes (below), and the old 4-arg overload is
-- DROPPED rather than left alongside. So the DB and the app are incompatible in
-- BOTH orders, for the gap between them:
--   · migration first  → the old app calls the 4-arg RPC → PostgREST PGRST202
--   · app first        → the new 6-arg RPC does not exist yet → same failure
-- Blast radius is admin account enable/disable ONLY. Every other route, all cron
-- jobs, and the whole member/staff parking flow are untouched. Deploy the app
-- immediately after the migration and exercise the exemplar route to confirm.
--
-- ROLLBACK is therefore NOT "revert the app". The old app cannot talk to this DB.
-- Either forward-fix the app, or restore the 4-arg wrapper first — and note that
-- doing so reintroduces an UNAUDITED write path, which is the thing this migration
-- exists to remove. Forward-fix is strongly preferred.
--
-- Its actor model could not have worked anyway: `actor_id uuid references users(id)`
-- can only express a MEMBER actor, but the actions worth auditing are overwhelmingly
-- taken by admins — and admins live in admin_accounts, not users. This repo has hit
-- that exact wall twice already and worked around it both times with a parallel
-- column, leaving the users(id) one dead forever (0025 decided_by_admin_id, and
-- 0028's comment: "admins live in admin_accounts, NOT users, so the legacy
-- resolved_by -> users(id) column stays unused/null forever"). audit_logs is the
-- third instance, and the only one that cannot be patched that way: its actor is
-- genuinely polymorphic (admin / staff session / member / job / system), so no
-- single FK can describe it. actor_id is therefore a SNAPSHOT REFERENCE with no FK,
-- and the log deliberately outlives the rows it points at.

do $$
begin
  if (select count(*) from audit_logs) > 0 then
    raise exception
      'audit_logs is not empty (% rows) — the reshape assumption is wrong, stop and reassess',
      (select count(*) from audit_logs);
  end if;
end $$;

-- ── private schema: not reachable through PostgREST, and not granted to the app ──
-- First private schema in this repo. It exists so that "the application cannot forge
-- an audit row" is a PRIVILEGE rather than a PostgREST configuration detail: the
-- writer below grants EXECUTE to nobody, and only owner-controlled SECURITY DEFINER
-- business RPCs can reach it.
create schema if not exists private;
revoke all on schema private from public;

create type audit_actor_type as enum ('admin', 'staff_session', 'member', 'job', 'system');

-- success = the audited change happened. denied = a governance guard refused it.
-- conflict = an optimistic-lock/version race lost. Ordinary input validation is NOT
-- audited: it is noise, and it would pull user-supplied values toward metadata.
create type audit_result as enum ('success', 'denied', 'conflict');

drop table audit_logs;

create table audit_logs (
  id                  uuid             primary key default gen_random_uuid(),
  created_at          timestamptz      not null default now(),

  -- Polymorphic actor. NO foreign keys by design (see header): actor_id is a
  -- snapshot ref that must survive deletion of whatever it points at.
  actor_type          audit_actor_type not null,
  actor_id            uuid,
  actor_session_id    uuid,
  -- The actor's role AS OF this action. Null until #19 introduces roles; when it
  -- lands, the auth layer must pass the role it read for THIS request. A viewer
  -- re-reading today's role would defeat the entire point of a snapshot.
  actor_role_snapshot text,

  -- '<entity_type>.<verb>', enforced by audit_logs_action_format_ck. Fixing the
  -- shape here keeps the 2A-2 viewer's filters and label mapping from fragmenting.
  action              text             not null,
  entity_type         text             not null,
  entity_id           uuid,

  -- The only real FK: weekly_events is never deleted (no delete path exists
  -- anywhere in the codebase). If that EVER changes this must become
  -- `on delete set null` — audit rows must not block operational cleanup, and
  -- must not be deleted along with an event.
  weekly_event_id     uuid             references weekly_events(id),

  -- Generated per mutation at the route and threaded route -> service -> repo ->
  -- RPC. NOT NULL so a future route that forgets to thread it fails loudly instead
  -- of quietly producing an untraceable row.
  request_id          uuid             not null,

  result              audit_result     not null,

  -- Flat, allowlisted, action-specific facts — assembled INSIDE the business RPC,
  -- never passed through from a route. See private.append_audit_log for the rules.
  metadata_redacted   jsonb            not null default '{}'::jsonb,

  -- Which identifiers each actor kind must (and must not) carry.
  --   admin/member    : a person acting through a known session.
  --   staff_session   : a SHARED per-event PIN credential — it identifies the
  --                     session, never a natural person, so there is no session to
  --                     distinguish and the viewer must never invent a name.
  --   job             : actor_id may reference job_runs; no session exists.
  --   system          : no actor at all. NEVER use this as a fallback for "actor
  --                     unavailable" — that would silently mask a threading bug.
  constraint audit_logs_actor_shape_ck check (
    case actor_type
      when 'admin'         then actor_id is not null and actor_session_id is not null
      when 'member'        then actor_id is not null and actor_session_id is not null
      when 'staff_session' then actor_id is not null and actor_session_id is null
      when 'job'           then actor_session_id is null
      when 'system'        then actor_id is null and actor_session_id is null
      else false
    end
  ),

  constraint audit_logs_action_format_ck
    check (action ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),

  constraint audit_logs_metadata_object_ck
    check (jsonb_typeof(metadata_redacted) = 'object')
);

-- The three access patterns the 2A-2 viewer needs: the timeline, one entity's
-- history, and one actor's history.
create index audit_logs_created_at_idx on audit_logs (created_at desc);
create index audit_logs_entity_idx     on audit_logs (entity_type, entity_id, created_at desc);
create index audit_logs_actor_idx      on audit_logs (actor_type, actor_id, created_at desc);

alter table audit_logs enable row level security;

-- ── Append-only, in two layers, for two different reasons ────────────────────────
-- service_role is NOT a superuser (rolsuper=f, rolbypassrls=t), so it bypasses RLS
-- but table GRANTS are still enforced against it. Revoking DML is therefore a real
-- control, not decoration. 0004 granted it blanket INSERT/UPDATE/DELETE (which also
-- carries TRUNCATE) on every table; audit_logs opts back out.
--
-- Layer 1 (grants) carries TRUNCATE, which does NOT fire row-level triggers.
-- Layer 2 (triggers) carries the case where a future migration repeats 0004's
--   blanket `grant ... on all tables to service_role` and silently restores DML —
--   this repo has already done that once, so it is a demonstrated hazard, not a
--   hypothetical one.
--
-- What this does NOT claim: immutability. The owner/migration role keeps DDL — that
-- is PostgreSQL reality. This is append-only against the APPLICATION principal.
-- It also does nothing about omission: the app still chooses whether to call an
-- audited RPC at all. It raises the cost of FORGING a row, not of skipping one.
revoke insert, update, delete, truncate on audit_logs from service_role;
grant select on audit_logs to service_role;

create function private.audit_logs_block_mutation() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'audit_logs is append-only (attempted %)', tg_op
    using errcode = '42501';
end $$;

create trigger audit_logs_no_mutation
  before update or delete on audit_logs
  for each row execute function private.audit_logs_block_mutation();

-- Separate trigger: TRUNCATE is statement-level and never reaches a FOR EACH ROW
-- trigger. Retention (2A-3) will need a deliberate escape hatch past both of these.
create trigger audit_logs_no_truncate
  before truncate on audit_logs
  for each statement execute function private.audit_logs_block_mutation();

-- ── private.append_audit_log — the only way a row is ever written ────────────────
-- SECURITY DEFINER, owned by postgres (which owns audit_logs and so retains the
-- INSERT that service_role just lost). EXECUTE is granted to NOBODY — not even
-- service_role. Only an owner-controlled SECURITY DEFINER business RPC, running as
-- postgres, can call it, and it does so INSIDE the business transaction so the
-- change and its log commit or roll back together.
--
-- The validation below is a SECOND line of defence. The primary control is that
-- metadata is assembled inside each business RPC from fixed, action-specific
-- fields — a route can never hand arbitrary JSON to this function.
--
-- Metadata is FLAT (depth 1, scalar values). That is what makes the key denylist a
-- complete scan: nesting would let PII ride along under an innocuous-looking parent
-- key. It also keeps the viewer's renderer trivial.
create function private.append_audit_log(
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
  v_id  uuid;
  v_key text;
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
  end loop;

  insert into audit_logs (
    actor_type, actor_id, actor_session_id, actor_role_snapshot,
    action, entity_type, entity_id, weekly_event_id,
    request_id, result, metadata_redacted
  ) values (
    p_actor_type, p_actor_id, p_actor_session_id, p_actor_role_snapshot,
    p_action, p_entity_type, p_entity_id, p_weekly_event_id,
    p_request_id, p_result, p_metadata
  )
  returning id into v_id;

  return v_id;
end $$;

revoke all on function private.append_audit_log(
  audit_actor_type, uuid, uuid, text, text, text, uuid, uuid, uuid, audit_result, jsonb
) from public, anon, authenticated, service_role;

-- ── Bootstrap marker ─────────────────────────────────────────────────────────────
-- No backfill. Historical state carries no reliable actor, request or before-value,
-- so converting it into "an admin did this at some point" would be fabricating
-- evidence. This single row records that the log starts here and why it is short.
insert into audit_logs (
  actor_type, actor_id, actor_session_id,
  action, entity_type, entity_id,
  request_id, result, metadata_redacted
) values (
  'system', null, null,
  'audit.substrate_enabled', 'audit', null,
  gen_random_uuid(), 'success',
  jsonb_build_object('schema_version', 2, 'historical_events_backfilled', false)
);

-- ── Exemplar: set_admin_disabled, now audited atomically ─────────────────────────
-- Unchanged in behaviour except that it records what it did. Two structural changes:
--
-- (1) SECURITY DEFINER. This is the first in the repo, and it is what lets the
--     function reach private.append_audit_log while the app cannot. Its two hazards
--     are already closed and are pinned by verify_schema so they stay closed:
--     `set search_path` is set (below), and EXECUTE is revoked from public/anon —
--     without that revoke, SECURITY DEFINER would turn this into a privilege
--     escalation vector reachable by anon through PostgREST.
--
-- (2) The signature gains p_acting_session_id and p_request_id, so the old overload
--     must be DROPPED, not replaced — `create or replace` with new parameters would
--     leave both versions callable and make the PostgREST call ambiguous.
--
-- Guard refusals stay TYPED RETURNS and are audited as result='denied'. This is
-- load-bearing, not stylistic: a `raise` would roll back the very audit row that
-- records the refusal. Only genuine infrastructure failure (the audit writer
-- erroring, the DB going away) may raise — and then rolling the business change
-- back is exactly right. #10 and #14A must be written the same way: version
-- conflict => 'conflict', capacity-below-approved => 'denied', both returned.
--
-- not_found is NOT audited: nothing was governed, it is a bad request.
drop function set_admin_disabled(uuid, uuid, boolean, timestamptz);

create function set_admin_disabled(
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
  v_disabled_at   timestamptz;
  v_state_changed boolean := false;
  v_action        text := case when p_disabled then 'admin_account.disable'
                                              else 'admin_account.enable' end;
begin
  if p_target_id = p_acting_admin_id then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, null,
      v_action, 'admin_account', p_target_id, null,
      p_request_id, 'denied',
      jsonb_build_object('reason', 'cannot_target_self')
    );
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
        perform private.append_audit_log(
          'admin', p_acting_admin_id, p_acting_session_id, null,
          v_action, 'admin_account', p_target_id, null,
          p_request_id, 'denied',
          jsonb_build_object('reason', 'last_active_admin')
        );
        return jsonb_build_object('ok', false, 'reason', 'last_active_admin');
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
  -- de-emphasise it instead. A genuinely inert no-op — e.g. #14A resubmitting an
  -- unchanged capacity — should not write a row at all.
  perform private.append_audit_log(
    'admin', p_acting_admin_id, p_acting_session_id, null,
    v_action, 'admin_account', p_target_id, null,
    p_request_id, 'success',
    jsonb_build_object('disabled_to', p_disabled, 'state_changed', v_state_changed)
  );

  return jsonb_build_object('ok', true);
end $$;

revoke all on function set_admin_disabled(uuid, uuid, uuid, boolean, timestamptz, uuid) from public;
grant execute on function set_admin_disabled(uuid, uuid, uuid, boolean, timestamptz, uuid) to service_role;
