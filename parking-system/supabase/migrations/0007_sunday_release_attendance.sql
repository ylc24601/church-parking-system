-- Phase 2 slice 3: Sunday release sweep + attendance check-in RPCs.
-- Conventions match 0005/0006: SET search_path, REVOKE FROM public + GRANT to service_role,
-- status-guarded UPDATEs for idempotency, outbox enqueued only for genuine recipients
-- (re-validated against live state), ON CONFLICT (dedupe_key) DO NOTHING.

-- ── Release sweep: approved past its own release_deadline_at → released_late ──────
-- Per-reservation release_deadline_at (P3=10:30, P2=10:45, P2 on-the-way=10:55) means a
-- single deadline-driven sweep implements all tiers. The broadcast goes to users STILL
-- waiting at apply time (recipients are NOT the released rows), gated on >=1 release.
create or replace function apply_release(
  p_event_id  uuid,
  p_now       timestamptz,
  p_broadcast jsonb      -- [{dedupe_key,template_key,reservation_id,payload}] — one per waiting candidate
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_released int; v_outbox int;
begin
  with released as (
    update reservations set status = 'released_late', released_at = p_now
    where weekly_event_id = p_event_id and status = 'approved'
      and attended_at is null and release_deadline_at <= p_now
    returning id
  ),
  ins as (   -- broadcast to users STILL waiting at RPC time, only when something was released
    insert into notification_outbox
      (dedupe_key, template_key, user_id, reservation_id, weekly_event_id, payload_json)
    select e->>'dedupe_key', e->>'template_key', r.user_id, r.id, p_event_id,
           coalesce(e->'payload', '{}'::jsonb)
    from jsonb_array_elements(p_broadcast) e
    join reservations r
      on r.id = (e->>'reservation_id')::uuid
     and r.weekly_event_id = p_event_id
     and r.status = 'waiting'                 -- re-validate against live state
    where (select count(*) from released) > 0
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select (select count(*) from released), (select count(*) from ins)
    into v_released, v_outbox;

  return jsonb_build_object('released', v_released, 'outbox_enqueued', v_outbox);
end $$;

-- ── Attendance check-in: approved/released_late → attended/attended_after_release ─
-- The target status is decided in TS (markAttendance, by now vs release_deadline_at);
-- the penalty recovery is applied atomically and only when the row actually transitioned.
create or replace function apply_attendance(
  p_event_id       uuid,
  p_reservation_id uuid,
  p_target_status  text,        -- 'attended' | 'attended_after_release'
  p_now            timestamptz,
  p_penalty        jsonb        -- null (walk-in) or {user_id,penalty_score,consecutive_no_show,last_successful_attended_at}
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_attended int; v_penalty int;
begin
  -- DB-level guard: reject any target status outside the allowed attendance transitions.
  if p_target_status not in ('attended', 'attended_after_release') then
    raise exception 'apply_attendance: invalid target status %', p_target_status;
  end if;

  with done as (
    update reservations set status = p_target_status::reservation_status, attended_at = p_now
    where id = p_reservation_id and weekly_event_id = p_event_id
      and status in ('approved', 'released_late')
    returning user_id
  ),
  pen as (   -- penalty recovery, gated on the attendance actually applying; skip walk-in (null user)
    insert into user_penalties (user_id, penalty_score, consecutive_no_show, last_successful_attended_at)
    select (p_penalty->>'user_id')::uuid, (p_penalty->>'penalty_score')::int,
           (p_penalty->>'consecutive_no_show')::int, (p_penalty->>'last_successful_attended_at')::date
    where p_penalty is not null and (select count(*) from done) = 1
    on conflict (user_id) do update set
      penalty_score               = excluded.penalty_score,
      consecutive_no_show         = excluded.consecutive_no_show,
      last_successful_attended_at = excluded.last_successful_attended_at
    returning 1
  )
  select (select count(*) from done), (select count(*) from pen)
    into v_attended, v_penalty;

  return jsonb_build_object('attended', v_attended, 'penalty_updated', v_penalty);
end $$;

-- Lock down both to service_role only.
revoke all on function apply_release(uuid, timestamptz, jsonb) from public;
revoke all on function apply_attendance(uuid, uuid, text, timestamptz, jsonb) from public;
grant execute on function apply_release(uuid, timestamptz, jsonb) to service_role;
grant execute on function apply_attendance(uuid, uuid, text, timestamptz, jsonb) to service_role;
