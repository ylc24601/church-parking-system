-- Wave 2A-3 (#15): audit_logs retention purge — the deliberate escape hatch that
-- 0030:170 promised ("Retention (2A-3) will need a deliberate escape hatch past
-- both of these"). Policy (feature-triage.md): keep 24 months online, purge monthly,
-- never claim永久保存. audit.substrate_enabled and audit.retention_purge are exempt
-- (they record where the trail starts and how it has been trimmed).
--
-- This migration:
--   (1) reopens ONE narrow seam in the append-only trigger — DELETE only, under a
--       double lock (a transaction-local GUC AND owner identity). UPDATE and TRUNCATE
--       stay absolutely blocked.
--   (2) adds purge_audit_logs — the bounded, idempotent, self-auditing retention RPC
--       whose clock is the DATABASE's, never the caller's (see below).
--   (3) adds a partial index matching the purge scan predicate.
--
-- ── DEPLOY: DB first, then app. Blast radius is one new cron. ─────────────────────
-- purge_audit_logs is brand new (old app never calls it); the trigger change only
-- LOOSENS (adds a seam the old app never opens, since it never sets the GUC). New app
-- + old DB: only the new monthly cron 404s at the RPC (PGRST202) and retries next
-- month. Rollback = drop purge_audit_logs + restore the trigger body below to its
-- 0030 form (which re-blocks all DELETE).
--
-- ── Why the clock is the DB's and not a parameter (divergence from 0027) ─────────
-- redact_decided_binding_pii takes p_now and is granted to service_role. For binding
-- PII that is tolerable: an early redaction moves TOWARD privacy. For an append-only
-- audit log, an early DELETE is irreversible evidence destruction. A caller passing
-- p_now = '2100-01-01' would mark almost every row expired. Ignoring `now` at the
-- route does not protect the DB, because the RPC is directly callable by anyone with
-- the service-role key. So this function has NO p_now: it reads now() itself, and the
-- 24-month floor below is enforced HERE, not upstream.

-- ── (1) reopen a narrow DELETE seam in the append-only trigger ───────────────────
-- Both locks are required, and each covers the other's failure mode:
--   * GUC (audit.allow_purge='on', transaction-local): only purge_audit_logs sets it.
--   * owner identity (current_user = audit_logs' owner): a SECURITY DEFINER purge runs
--     AS the owner, so current_user is the owner; a direct DELETE by the app principal
--     has current_user = service_role and fails this arm even if a future migration
--     repeats 0004's blanket grant and even if something sets the GUC. (0030:144-147
--     flags that blanket-grant regression as a demonstrated hazard, not hypothetical.)
-- UPDATE and TRUNCATE are never permitted — the purge is a bounded, predicated DELETE.
create or replace function private.audit_logs_block_mutation() returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE'
     and current_setting('audit.allow_purge', true) = 'on'
     and current_user = (
           select r.rolname from pg_class c
             join pg_roles r on r.oid = c.relowner
            where c.oid = 'public.audit_logs'::regclass
         )
  then
    return old;
  end if;
  raise exception 'audit_logs is append-only (attempted %)', tg_op
    using errcode = '42501';
end $$;

-- ── (2) purge_audit_logs — bounded, idempotent, self-auditing retention sweep ─────
-- Conservative and idempotent, mirroring redact_decided_binding_pii except:
--   * NO p_now — the clock is now() inside the function (see header);
--   * hard floor is the policy itself (>= 24 months): audit has no legitimate reason
--     to retain LESS than policy, so the window may only ever be LENGTHENED;
--   * dry-run returns the TRUE total (count(*) over the same predicate) so the
--     operator sees the real backlog — apply and dry-run share the WHERE clause, so
--     the preview can never drift from what apply touches;
--   * apply reports has_more honestly (unlike 0027:106) because this runs MONTHLY: a
--     stranded backlog would otherwise wait a whole month; the service drains it in a
--     bounded loop;
--   * it records ITSELF as a 'system' action — but only when it actually deleted
--     something. A zero-delete run (every month until rows first age past 24 months)
--     writes nothing, keeping the retention-exempt marker set tiny (0030:369's rule).
create function purge_audit_logs(
  p_retention_months int,
  p_max              int,
  p_dry_run          boolean,
  p_request_id       uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now      timestamptz := now();   -- DB clock; the caller cannot supply it
  v_cutoff   timestamptz;
  v_count    int;
  v_has_more boolean;
begin
  -- Every parameter explicitly null-guarded: under three-valued logic a bare
  -- `p_retention_months < 24` is NULL (not true) for a NULL input, so without these
  -- a NULL argument would silently skip the guard.
  if p_retention_months is null or p_retention_months < 24 then
    raise exception 'p_retention_months must be an integer >= 24';
  end if;
  if p_max is null or p_max < 1 or p_max > 500 then
    raise exception 'p_max must be between 1 and 500';
  end if;
  if p_dry_run is null then
    raise exception 'p_dry_run is required';
  end if;
  -- Required so the marker below correlates with the route / job log, and so a route
  -- that forgets to thread it fails loudly rather than writing an untraceable row.
  if p_request_id is null then
    raise exception 'p_request_id is required';
  end if;

  v_cutoff := v_now - make_interval(months => p_retention_months);

  if p_dry_run then
    -- True total over the same predicate apply uses (no drift). Read-only.
    select count(*) into v_count
      from audit_logs
     where created_at < v_cutoff
       and action not in ('audit.substrate_enabled', 'audit.retention_purge');
    return jsonb_build_object(
      'count', v_count,
      'has_more', false,
      'deleted_before', v_cutoff::text,
      'retention_months', p_retention_months
    );
  end if;

  -- Open the seam (transaction-local); the trigger above checks it.
  perform set_config('audit.allow_purge', 'on', true);

  with target as (
    select id from audit_logs
     where created_at < v_cutoff
       and action not in ('audit.substrate_enabled', 'audit.retention_purge')
     order by created_at            -- oldest first
     limit p_max
     for update skip locked         -- never fight a concurrent run
  ),
  done as (
    delete from audit_logs a using target t where a.id = t.id
    returning 1
  )
  select count(*) into v_count from done;

  -- Close the seam immediately — do not rely on transaction end. Any DELETE later in
  -- this same transaction must be blocked again (pinned by a test).
  perform set_config('audit.allow_purge', 'off', true);

  select exists (
    select 1 from audit_logs
     where created_at < v_cutoff
       and action not in ('audit.substrate_enabled', 'audit.retention_purge')
  ) into v_has_more;

  -- Record the purge itself — only when it removed something. metadata is flat,
  -- scalar, and carries NO deleted IDs / actors / anything from the deleted rows:
  -- deleted_before (the strict `<` boundary), the count, and the policy window.
  if v_count > 0 then
    perform private.append_audit_log(
      'system', null, null, null,
      'audit.retention_purge', 'audit', null, null,
      p_request_id, 'success',
      jsonb_build_object(
        'deleted_before', v_cutoff::text,
        'deleted_count', v_count,
        'retention_months', p_retention_months
      )
    );
  end if;

  return jsonb_build_object(
    'count', v_count,
    'has_more', v_has_more,
    'deleted_before', v_cutoff::text,
    'retention_months', p_retention_months
  );
end $$;

revoke all on function purge_audit_logs(int, int, boolean, uuid) from public;
grant execute on function purge_audit_logs(int, int, boolean, uuid) to service_role;

-- ── (3) partial index for the purge scan (shrinks as rows age out) ────────────────
create index audit_logs_retention_idx
  on audit_logs (created_at)
  where action not in ('audit.substrate_enabled', 'audit.retention_purge');
