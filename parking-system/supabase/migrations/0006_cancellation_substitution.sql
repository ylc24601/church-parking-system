-- Phase 2 slice 2: atomic cancellation + substitution + offer-resolution RPCs.
-- Conventions match 0005: SET search_path, REVOKE FROM public + GRANT to service_role,
-- status-guarded UPDATEs for idempotency, outbox enqueued only for rows actually updated
-- (UPDATE ... RETURNING joined to the outbox payload), ON CONFLICT (dedupe_key) DO NOTHING.

-- ── Cancel (+ optional first substitution offer), atomic ─────────────────────────
create or replace function apply_cancellation(
  p_event_id      uuid,
  p_cancel_id     uuid,
  p_cancel_status text,    -- 'cancelled_by_user' | 'cancelled_late'
  p_expect_status text,    -- the status read (guard for idempotency)
  p_now           timestamptz,
  p_substitute    jsonb,   -- null, or {id,status,offer_expires_at,last_offer_at,approved_at,release_deadline_at}
  p_outbox        jsonb
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_cancelled int; v_sub int; v_outbox int;
begin
  with cancelled as (
    update reservations set status = p_cancel_status::reservation_status, cancelled_at = p_now
    where id = p_cancel_id and status = p_expect_status::reservation_status
    returning id
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
  ins as (
    insert into notification_outbox
      (dedupe_key, template_key, user_id, reservation_id, weekly_event_id, payload_json)
    select e->>'dedupe_key', e->>'template_key', (e->>'user_id')::uuid,
           (e->>'reservation_id')::uuid, p_event_id, coalesce(e->'payload','{}'::jsonb)
    from jsonb_array_elements(p_outbox) e
    join sub on sub.id = (e->>'reservation_id')::uuid
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select (select count(*) from cancelled), (select count(*) from sub), (select count(*) from ins)
    into v_cancelled, v_sub, v_outbox;

  return jsonb_build_object('cancelled', v_cancelled, 'substitute_applied', v_sub, 'outbox_enqueued', v_outbox);
end $$;

-- ── Offer-only (promote one waiting candidate), for race retries ─────────────────
create or replace function apply_offer(
  p_event_id   uuid,
  p_substitute jsonb,    -- {id,status,offer_expires_at,last_offer_at,approved_at,release_deadline_at}
  p_outbox     jsonb
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_offered int; v_outbox int;
begin
  with sub as (
    update reservations r set
      status              = (p_substitute->>'status')::reservation_status,
      offer_expires_at    = (p_substitute->>'offer_expires_at')::timestamptz,
      last_offer_at       = (p_substitute->>'last_offer_at')::timestamptz,
      approved_at         = (p_substitute->>'approved_at')::timestamptz,
      release_deadline_at = (p_substitute->>'release_deadline_at')::timestamptz
    where r.id = (p_substitute->>'id')::uuid and r.status = 'waiting'
    returning r.id
  ),
  ins as (
    insert into notification_outbox
      (dedupe_key, template_key, user_id, reservation_id, weekly_event_id, payload_json)
    select e->>'dedupe_key', e->>'template_key', (e->>'user_id')::uuid,
           (e->>'reservation_id')::uuid, p_event_id, coalesce(e->'payload','{}'::jsonb)
    from jsonb_array_elements(p_outbox) e
    join sub on sub.id = (e->>'reservation_id')::uuid
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select (select count(*) from sub), (select count(*) from ins) into v_offered, v_outbox;
  return jsonb_build_object('offered', v_offered, 'outbox_enqueued', v_outbox);
end $$;

-- ── Resolve an offer (confirm / expire / decline) + optional next offer, atomic ──
create or replace function apply_offer_resolution(
  p_event_id uuid,
  p_offer_id uuid,
  p_outcome  text,     -- 'confirmed' | 'expired' | 'declined'
  p_now      timestamptz,
  p_approved jsonb,    -- for 'confirmed': {approved_at, release_deadline_at}
  p_next     jsonb,    -- for expire/decline: substitute or null
  p_outbox   jsonb
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_resolved int; v_next int; v_outbox int;
begin
  with resolved as (
    update reservations r set
      status = case when p_outcome = 'confirmed' then 'approved'::reservation_status
                    else 'waiting'::reservation_status end,
      offer_status = case when p_outcome = 'declined' then 'declined'::offer_status
                          when p_outcome = 'expired'  then 'expired'::offer_status
                          else r.offer_status end,
      offer_expires_at = null,
      approved_at = case when p_outcome = 'confirmed' then (p_approved->>'approved_at')::timestamptz
                         else r.approved_at end,
      release_deadline_at = case when p_outcome = 'confirmed'
                                 then (p_approved->>'release_deadline_at')::timestamptz
                                 else r.release_deadline_at end
    where r.id = p_offer_id and r.status = 'temp_approved'
      and (p_outcome <> 'expired' or r.offer_expires_at <= p_now)
    returning r.id
  ),
  nxt as (   -- expire/decline only: offer the freed spot to the next candidate
    update reservations r set
      status              = (p_next->>'status')::reservation_status,
      offer_expires_at    = (p_next->>'offer_expires_at')::timestamptz,
      last_offer_at       = (p_next->>'last_offer_at')::timestamptz,
      approved_at         = (p_next->>'approved_at')::timestamptz,
      release_deadline_at = (p_next->>'release_deadline_at')::timestamptz
    where p_next is not null
      and r.id = (p_next->>'id')::uuid and r.status = 'waiting'
      and (select count(*) from resolved) = 1
    returning r.id
  ),
  ins as (   -- outbox for ALL updated rows: resolved (confirm/auto-approve) + next (expire/decline)
    insert into notification_outbox
      (dedupe_key, template_key, user_id, reservation_id, weekly_event_id, payload_json)
    select e->>'dedupe_key', e->>'template_key', (e->>'user_id')::uuid,
           (e->>'reservation_id')::uuid, p_event_id, coalesce(e->'payload','{}'::jsonb)
    from jsonb_array_elements(p_outbox) e
    join (select id from resolved union all select id from nxt) u on u.id = (e->>'reservation_id')::uuid
    on conflict (dedupe_key) do nothing
    returning 1
  )
  select (select count(*) from resolved), (select count(*) from nxt), (select count(*) from ins)
    into v_resolved, v_next, v_outbox;

  return jsonb_build_object('resolved', v_resolved, 'next_applied', v_next, 'outbox_enqueued', v_outbox);
end $$;

-- Lock down all three to service_role only.
revoke all on function apply_cancellation(uuid,uuid,text,text,timestamptz,jsonb,jsonb) from public;
revoke all on function apply_offer(uuid,jsonb,jsonb) from public;
revoke all on function apply_offer_resolution(uuid,uuid,text,timestamptz,jsonb,jsonb,jsonb) from public;
grant execute on function apply_cancellation(uuid,uuid,text,text,timestamptz,jsonb,jsonb) to service_role;
grant execute on function apply_offer(uuid,jsonb,jsonb) to service_role;
grant execute on function apply_offer_resolution(uuid,uuid,text,timestamptz,jsonb,jsonb,jsonb) to service_role;
