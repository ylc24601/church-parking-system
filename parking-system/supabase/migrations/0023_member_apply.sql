-- Phase 7 Slice 3: member reservation apply.
-- Until now reservations were created only by seed / walk-in; this adds the member-facing
-- apply as one atomic, typed RPC. Business logic (effective_priority per development_plan §4)
-- is computed in TypeScript (lib/allocation/priority.ts) and passed in; the RPC owns only the
-- transactional guards:
--   event_not_open → applications_closed → vehicle_not_owned → already_applied → applied
--
-- The apply window closes when the Friday allocation job claims the event: a job_runs row for
-- 'friday_allocation' (see FRIDAY_ALLOCATION_JOB in fridayAllocationService.ts — keep in sync)
-- in 'running' or 'success'. Rows inserted after the allocator read its pending snapshot would
-- otherwise sit 'pending' forever; late members go through Sunday walk-in instead
-- (waiting-tail join is v2 backlog).
--
-- Concurrency protocol (PR #16 review): the job_runs check alone cannot see an allocation that
-- is claiming CONCURRENTLY (READ COMMITTED hides its uncommitted 'running' row), so apply and
-- claim serialize on the weekly_events row lock:
--   * apply_reservation locks the event row FOR UPDATE before its window check;
--   * claim_friday_allocation (below) locks the SAME row before marking 'running', and the
--     allocator reads its pending snapshot only after that claim has committed.
-- Ordering therefore guarantees: an apply that commits first is in the allocator's snapshot;
-- a claim that commits first makes every later apply see 'running' → applications_closed.

create or replace function apply_reservation(
  p_event_id           uuid,
  p_user_id            uuid,
  p_vehicle_id         uuid,
  p_requested_p2       boolean,
  p_effective_priority smallint,
  p_now                timestamptz
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_id     uuid;
begin
  -- Lock the event row: serializes this window check against claim_friday_allocation.
  select status into v_status from weekly_events where id = p_event_id for update;
  if not found or v_status <> 'open' then
    return jsonb_build_object('applied', 0, 'reason', 'event_not_open');
  end if;

  perform 1 from job_runs
    where weekly_event_id = p_event_id
      and job_type = 'friday_allocation'
      and status in ('running', 'success');
  if found then
    return jsonb_build_object('applied', 0, 'reason', 'applications_closed');
  end if;

  -- The vehicle must belong to the applicant and still be active.
  perform 1 from vehicles
    where id = p_vehicle_id and user_id = p_user_id and is_active;
  if not found then
    return jsonb_build_object('applied', 0, 'reason', 'vehicle_not_owned');
  end if;

  -- One active reservation per member per week: the partial unique index
  -- reservations_one_active_per_member is the authoritative guard (cancelled rows
  -- excluded, so a member may re-apply after cancelling).
  begin
    insert into reservations
      (weekly_event_id, user_id, vehicle_id, requested_p2_this_week, effective_priority,
       status, applied_at)
    values
      (p_event_id, p_user_id, p_vehicle_id, p_requested_p2, p_effective_priority,
       'pending', p_now)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('applied', 0, 'reason', 'already_applied');
  end;

  return jsonb_build_object('applied', 1, 'reason', 'applied', 'reservation_id', v_id);
end $$;

revoke all on function apply_reservation(uuid, uuid, uuid, boolean, smallint, timestamptz) from public;
grant execute on function apply_reservation(uuid, uuid, uuid, boolean, smallint, timestamptz) to service_role;

-- ── claim_friday_allocation — the allocator's half of the locking protocol ────────────────────────
-- Marks the event's allocation run 'running' UNDER the weekly_events row lock and commits before
-- the allocator reads its pending snapshot (fridayAllocationService calls this first). The
-- existing conditional-claim semantics of apply_friday_allocation (0005) are preserved: a prior
-- 'success' short-circuits, 'running'/'failed' rows are reclaimed (a crashed run keeps the window
-- closed until the Friday job reruns — an ops-visible state, not a member-facing one).
create or replace function claim_friday_allocation(
  p_event_id uuid,
  p_job_type text
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_status job_run_status;
begin
  perform 1 from weekly_events where id = p_event_id for update;
  if not found then
    return jsonb_build_object('claimed', false, 'reason', 'event_not_found');
  end if;

  insert into job_runs (weekly_event_id, job_type, status)
    values (p_event_id, p_job_type, 'running')
    on conflict (weekly_event_id, job_type)
    do update set status = 'running', started_at = now(), error_message = null
    where job_runs.status <> 'success';

  select status into v_status
    from job_runs where weekly_event_id = p_event_id and job_type = p_job_type;
  if v_status = 'success' then
    return jsonb_build_object('claimed', false, 'reason', 'already_succeeded');
  end if;
  return jsonb_build_object('claimed', true, 'reason', 'claimed');
end $$;

revoke all on function claim_friday_allocation(uuid, text) from public;
grant execute on function claim_friday_allocation(uuid, text) to service_role;
