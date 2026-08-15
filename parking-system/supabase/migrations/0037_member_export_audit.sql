-- Wave 3 3d (#5B-a): audited, DB-authoritative gate for the member-roster CSV export.
--
-- 5A shipped roster browsing but deliberately no export (bulk PII egress is the highest
-- one-shot leak risk), leaving "who may export" to the role tier. #19 delivered the tier;
-- this migration adds the one primitive the export needs that the app cannot do itself:
-- write an audit row (private.append_audit_log is EXECUTE-locked to owner-controlled
-- SECURITY DEFINER RPCs — 0030). The same RPC also RE-AUTHORISES against the DB's current
-- role immediately before the CSV is delivered, so a role that was superadmin at the HTTP
-- gate but demoted mid-request cannot complete the egress. The route's can() is the primary
-- gate + UX; this is the DB-authoritative gate.
--
-- ── DEPLOY: additive, but still DB-FIRST ─────────────────────────────────────────
-- Adds one new RPC; removes/changes nothing. old-app + new-DB is fine. new-app + old-DB
-- makes the export route fail (RPC missing). Order stays: migration → db:verify:remote →
-- app → superadmin smoke (prod-deploy-runbook.md §1.5).
--
-- ── Divergences from the 0036 account-management template (deliberate) ────────────
-- 1. NO advisory lock: 0036's pg_advisory_xact_lock('active_superadmin_invariant') serialises
--    WRITES to admin_accounts and defends the last-superadmin invariant. This RPC only READS
--    the acting account and appends an audit row — it mutates no admin_accounts state — so it
--    needs neither the invariant nor the lock.
-- 2. Denied paths are NOT audited (v1 product decision): a refused export delivers no PII, so
--    there is nothing to record. (Contrast 0036, where a denied account-management attempt IS
--    a security-relevant event.) Only a successful, authorised export writes a row.
-- 3. Kept from 0036: acting-account read of role AND disabled_at FOR SHARE (holds the actor row
--    so a concurrent demote/disable cannot overturn this authorisation inside the audit txn);
--    role read here, never asserted by the caller; the verified role is what the audit records.

create function log_member_roster_export(
  p_acting_admin_id   uuid,
  p_acting_session_id uuid,
  p_request_id        uuid,
  p_row_count         int
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acting_role        admin_role;
  v_acting_disabled_at timestamptz;
begin
  -- p_row_count is threaded from the service, never user input. A null/negative value is a
  -- threading bug and must not be recorded as a real export — fail loud rather than write
  -- {row_count:null} as a false success.
  if p_row_count is null or p_row_count < 0 then
    raise exception 'log_member_roster_export: p_row_count must be a non-negative integer';
  end if;

  -- Acting-account read FOR SHARE (0036 discipline). Neither column in the WHERE, so
  -- "no such account" and "account disabled" stay distinct and a disabled actor's role is
  -- still readable. Denied paths return typed and write NO audit (divergence 2).
  select role, disabled_at into v_acting_role, v_acting_disabled_at
    from admin_accounts where id = p_acting_admin_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_not_found');
  end if;
  if v_acting_disabled_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_disabled');
  end if;
  if v_acting_role <> 'superadmin' then
    return jsonb_build_object('ok', false, 'reason', 'forbidden_role');
  end if;

  -- Success = "the system authorised and generated a roster export response" (NOT "the user
  -- saved a file" — the server cannot know that). actor_role_snapshot is the value just
  -- verified. No PII: entity_id/event_id null, metadata is the row count only.
  perform private.append_audit_log(
    'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
    'member_roster.export', 'member_roster', null, null,
    p_request_id, 'success', jsonb_build_object('row_count', p_row_count));

  return jsonb_build_object('ok', true);
end $$;

revoke all on function log_member_roster_export(uuid, uuid, uuid, int) from public, anon, authenticated;
grant execute on function log_member_roster_export(uuid, uuid, uuid, int) to service_role;

-- The export's membership cutoff must come from the DB clock, not the app (Vercel) clock:
-- the two can skew, and users.created_at is set by the DB's now(), so filtering
-- `created_at < <app now>` could mis-classify a member created near the export start. This
-- reads the same clock as the column it bounds. NOTE: it fixes a stable upper bound — it is
-- NOT a transaction snapshot (the export's keyset pages are separate statements).
create function db_now() returns timestamptz language sql stable as $$ select now() $$;
revoke all on function db_now() from public, anon, authenticated;
grant execute on function db_now() to service_role;
