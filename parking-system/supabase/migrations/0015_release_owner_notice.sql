-- Phase 4 Slice D: release-member notification.
-- The Sunday release sweep now ALSO notifies the member whose own seat was released this
-- sweep (approved → released_late), in addition to the existing broadcast to waiting users.
-- apply_release gains a 4th arg p_owner_notices; the old 3-arg signature is kept as a thin
-- wrapper (delegates with an empty owner-notice list) so existing callers keep working — no
-- breaking RPC change.
--
-- Conventions match 0007: SET search_path, revoke from public + grant to service_role,
-- recipients re-validated against live state, ON CONFLICT (dedupe_key) DO NOTHING.

-- ── 4-arg apply_release: broadcast (waiting users) + owner notices (released owners) ──────
create or replace function apply_release(
  p_event_id      uuid,
  p_now           timestamptz,
  p_broadcast     jsonb,   -- [{dedupe_key,template_key,reservation_id,payload}] — one per waiting candidate
  p_owner_notices jsonb    -- [{dedupe_key,template_key,reservation_id,user_id,payload}] — one per released owner
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_released int; v_outbox int; v_owner int;
begin
  with released as (
    update reservations set status = 'released_late', released_at = p_now
    where weekly_event_id = p_event_id and status = 'approved'
      and attended_at is null and release_deadline_at <= p_now
    returning id, user_id
  ),
  ins_broadcast as (   -- broadcast to users STILL waiting at RPC time, only when something was released
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
  ),
  ins_owner as (   -- notify each member whose OWN seat was released THIS sweep (rows in `released` only)
    insert into notification_outbox
      (dedupe_key, template_key, user_id, reservation_id, weekly_event_id, payload_json)
    select e->>'dedupe_key', 'reservation_released', rel.user_id, rel.id, p_event_id,
           coalesce(e->'payload', '{}'::jsonb)
    from jsonb_array_elements(p_owner_notices) e
    join released rel
      on  rel.id      = (e->>'reservation_id')::uuid   -- the notice matches a row released this sweep, AND
     and  rel.user_id = (e->>'user_id')::uuid          -- the intended recipient matches that row's owner
    where e->>'template_key' = 'reservation_released'   -- and it is exactly the release-owner template
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select (select count(*) from released),
         (select count(*) from ins_broadcast),
         (select count(*) from ins_owner)
    into v_released, v_outbox, v_owner;

  return jsonb_build_object(
    'released', v_released,
    'outbox_enqueued', v_outbox,
    'owner_notices_enqueued', v_owner
  );
end $$;

-- ── Backward-compatible 3-arg wrapper (delegates with no owner notices) ───────────────────
create or replace function apply_release(
  p_event_id  uuid,
  p_now       timestamptz,
  p_broadcast jsonb
) returns jsonb
language sql
set search_path = public, pg_temp
as $$
  select apply_release(p_event_id, p_now, p_broadcast, '[]'::jsonb);
$$;

-- Lock both signatures to service_role only.
revoke all on function apply_release(uuid, timestamptz, jsonb, jsonb) from public;
revoke all on function apply_release(uuid, timestamptz, jsonb)        from public;
grant execute on function apply_release(uuid, timestamptz, jsonb, jsonb) to service_role;
grant execute on function apply_release(uuid, timestamptz, jsonb)        to service_role;
