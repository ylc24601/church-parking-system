-- Phase 3 v2 — Staff real PIN session.
-- staff_sessions (created in 0003) holds one shared PIN credential per weekly_event:
-- pin_hash + expires_at + failed_attempts + locked_at. This migration adds the
-- per-event uniqueness the CLI upsert relies on, plus an atomic failure-counter RPC.
-- The table predates 0004's blanket `grant ... on all tables to service_role`, so
-- service_role can already read/write it; RLS stays deny-all (service_role bypasses).

-- One PIN row per event (supports `on conflict (weekly_event_id)` upsert from the CLI).
create unique index staff_sessions_event_unique on staff_sessions (weekly_event_id);

-- Atomic wrong-PIN counter: increment failed_attempts and lock (set locked_at=now)
-- when the new count reaches the threshold. Done in one statement so concurrent
-- failed logins can't under-count via read-modify-write. Threshold comes from the
-- TS single-source (STAFF_PIN_MAX_ATTEMPTS), passed in as p_threshold.
create or replace function apply_staff_pin_failure(
  p_id        uuid,
  p_threshold int
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_failed int; v_locked timestamptz;
begin
  update staff_sessions
     set failed_attempts = failed_attempts + 1,
         locked_at = case when failed_attempts + 1 >= p_threshold then now() else locked_at end
   where id = p_id
   returning failed_attempts, locked_at into v_failed, v_locked;

  if not found then
    return null;
  end if;
  return jsonb_build_object('failed_attempts', v_failed, 'locked_at', v_locked);
end $$;

revoke all on function apply_staff_pin_failure(uuid, int) from public;
grant execute on function apply_staff_pin_failure(uuid, int) to service_role;
