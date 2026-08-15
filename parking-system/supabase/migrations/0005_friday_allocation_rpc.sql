-- Phase 2 slice 1: read view + atomic Friday-allocation apply RPC.

-- Read view: supabase-js can't express the reservations↔user_penalties join (the FK
-- is via users), so expose a view the service can select pending rows from.
create view v_reservations_for_allocation as
select r.*,
       coalesce(p.penalty_score, 0) as penalty_score,
       p.last_successful_attended_at
from reservations r
left join user_penalties p on p.user_id = r.user_id;

revoke all on v_reservations_for_allocation from public;
grant select on v_reservations_for_allocation to service_role;  -- server reads pending rows

-- Atomic apply: claim job + update pending reservations + enqueue outbox (only for
-- rows actually updated) + finalize job, all in one transaction.
create or replace function apply_friday_allocation(
  p_event_id     uuid,
  p_job_type     text,
  p_reservations jsonb,   -- [{id,status,allocation_order,approved_at,release_deadline_at}]
  p_outbox       jsonb    -- [{dedupe_key,template_key,user_id,reservation_id,payload}]
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_status  job_run_status;
  v_updated int;
  v_outbox  int;
begin
  -- Conditional claim: only a prior 'success' short-circuits (apply is idempotent,
  -- so a 'running'/'failed' row is safely reclaimed).
  insert into job_runs (weekly_event_id, job_type, status)
    values (p_event_id, p_job_type, 'running')
    on conflict (weekly_event_id, job_type)
    do update set status = 'running', started_at = now(), error_message = null
    where job_runs.status <> 'success';

  select status into v_status
    from job_runs where weekly_event_id = p_event_id and job_type = p_job_type;
  if v_status = 'success' then
    return jsonb_build_object('skipped', true);
  end if;

  -- Update only still-pending rows; enqueue outbox ONLY for the rows actually updated
  -- (join p_outbox to the UPDATE ... RETURNING set) — single statement = atomic.
  with payload as (
    select (e->>'id')::uuid                  as id,
           (e->>'status')::reservation_status as status,
           (e->>'allocation_order')::int      as allocation_order,
           (e->>'approved_at')::timestamptz   as approved_at,
           (e->>'release_deadline_at')::timestamptz as release_deadline_at
    from jsonb_array_elements(p_reservations) e
  ),
  upd as (
    update reservations r set
      status              = pl.status,
      allocation_order    = pl.allocation_order,
      approved_at         = pl.approved_at,
      release_deadline_at = pl.release_deadline_at
    from payload pl
    where r.id = pl.id
      and r.weekly_event_id = p_event_id
      and r.status = 'pending'
    returning r.id
  ),
  ob as (
    select e->>'dedupe_key'              as dedupe_key,
           e->>'template_key'            as template_key,
           (e->>'user_id')::uuid         as user_id,
           (e->>'reservation_id')::uuid  as reservation_id,
           coalesce(e->'payload', '{}'::jsonb) as payload
    from jsonb_array_elements(p_outbox) e
  ),
  ins as (
    insert into notification_outbox
      (dedupe_key, template_key, user_id, reservation_id, weekly_event_id, payload_json)
    select ob.dedupe_key, ob.template_key, ob.user_id, ob.reservation_id, p_event_id, ob.payload
    from ob
    join upd on upd.id = ob.reservation_id
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select (select count(*) from upd), (select count(*) from ins)
    into v_updated, v_outbox;

  update job_runs set status = 'success', finished_at = now()
    where weekly_event_id = p_event_id and job_type = p_job_type;

  return jsonb_build_object('skipped', false, 'updated', v_updated, 'outbox_enqueued', v_outbox);
end $$;

revoke all on function apply_friday_allocation(uuid, text, jsonb, jsonb) from public;
grant execute on function apply_friday_allocation(uuid, text, jsonb, jsonb) to service_role;
