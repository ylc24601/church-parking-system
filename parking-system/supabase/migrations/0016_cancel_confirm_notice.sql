-- Phase 4 Slice E: cancellation-confirmation notice.
-- apply_cancellation now ALSO enqueues a confirmation to the MEMBER WHO CANCELLED (the row that
-- transitioned this call), in addition to the existing substitute-offer to the next waiting member.
-- Gains a new 8th arg p_cancel_notice; the old 7-arg signature is kept as a thin wrapper (delegates
-- with an empty list) so existing callers keep working — no breaking RPC change.
--
-- Conventions match 0006: SET search_path, revoke from public + grant to service_role,
-- recipients re-validated against live state, ON CONFLICT (dedupe_key) DO NOTHING.

-- ── 8-arg apply_cancellation: cancel (+ optional substitute offer) + cancel-confirmation ──────────
create or replace function apply_cancellation(
  p_event_id      uuid,
  p_cancel_id     uuid,
  p_cancel_status text,    -- 'cancelled_by_user' | 'cancelled_late'
  p_expect_status text,    -- the status read (guard for idempotency)
  p_now           timestamptz,
  p_substitute    jsonb,   -- null, or {id,status,offer_expires_at,last_offer_at,approved_at,release_deadline_at}
  p_outbox        jsonb,   -- substitute-offer outbox rows (joined to the promoted `sub` row)
  p_cancel_notice jsonb    -- [{dedupe_key,template_key,user_id,reservation_id}] — one for the cancelling member
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_cancelled int; v_sub int; v_outbox int; v_cancel_notice int;
begin
  with cancelled as (
    update reservations set status = p_cancel_status::reservation_status, cancelled_at = p_now
    where id = p_cancel_id and status = p_expect_status::reservation_status
    returning id, user_id, status
  ),
  sub as (   -- promote the chosen waiting candidate iff the cancel actually happened
    update reservations r set
      status              = (p_substitute->>'status')::reservation_status,
      offer_expires_at    = (p_substitute->>'offer_expires_at')::timestamptz,
      last_offer_at       = (p_substitute->>'last_offer_at')::timestamptz,
      approved_at         = (p_substitute->>'approved_at')::timestamptz,
      release_deadline_at = (p_substitute->>'release_deadline_at')::timestamptz
    where p_substitute is not null
      and r.id = (p_substitute->>'id')::uuid and r.status = 'waiting'
      and (select count(*) from cancelled) = 1
    returning r.id
  ),
  ins as (   -- substitute-offer outbox (unchanged): only for the promoted candidate
    insert into notification_outbox
      (dedupe_key, template_key, user_id, reservation_id, weekly_event_id, payload_json)
    select e->>'dedupe_key', e->>'template_key', (e->>'user_id')::uuid,
           (e->>'reservation_id')::uuid, p_event_id, coalesce(e->'payload','{}'::jsonb)
    from jsonb_array_elements(p_outbox) e
    join sub on sub.id = (e->>'reservation_id')::uuid
    on conflict (dedupe_key) do nothing
    returning 1
  ),
  ins_cancel as (   -- confirmation to the MEMBER WHO CANCELLED (rows in `cancelled` only, this call)
    insert into notification_outbox
      (dedupe_key, template_key, user_id, reservation_id, weekly_event_id, payload_json)
    select e->>'dedupe_key', 'reservation_cancelled', c.user_id, c.id, p_event_id,
           jsonb_build_object('cancel_status', c.status)   -- authoritative from the transitioned row
    from jsonb_array_elements(p_cancel_notice) e
    join cancelled c
      on  c.id      = (e->>'reservation_id')::uuid   -- the notice matches the row cancelled this call, AND
     and  c.user_id = (e->>'user_id')::uuid          -- the intended recipient matches that row's owner
    where e->>'template_key' = 'reservation_cancelled'  -- and it is exactly the cancel-confirmation template
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select (select count(*) from cancelled), (select count(*) from sub),
         (select count(*) from ins), (select count(*) from ins_cancel)
    into v_cancelled, v_sub, v_outbox, v_cancel_notice;

  return jsonb_build_object(
    'cancelled', v_cancelled,
    'substitute_applied', v_sub,
    'outbox_enqueued', v_outbox,
    'cancel_notice_enqueued', v_cancel_notice
  );
end $$;

-- ── Backward-compatible 7-arg wrapper (delegates with no cancel notice) ───────────────────────────
create or replace function apply_cancellation(
  p_event_id      uuid,
  p_cancel_id     uuid,
  p_cancel_status text,
  p_expect_status text,
  p_now           timestamptz,
  p_substitute    jsonb,
  p_outbox        jsonb
) returns jsonb
language sql
set search_path = public, pg_temp
as $$
  select apply_cancellation(p_event_id, p_cancel_id, p_cancel_status, p_expect_status,
                            p_now, p_substitute, p_outbox, '[]'::jsonb);
$$;

-- Lock both signatures to service_role only.
revoke all on function apply_cancellation(uuid,uuid,text,text,timestamptz,jsonb,jsonb,jsonb) from public;
revoke all on function apply_cancellation(uuid,uuid,text,text,timestamptz,jsonb,jsonb)       from public;
grant execute on function apply_cancellation(uuid,uuid,text,text,timestamptz,jsonb,jsonb,jsonb) to service_role;
grant execute on function apply_cancellation(uuid,uuid,text,text,timestamptz,jsonb,jsonb)       to service_role;
