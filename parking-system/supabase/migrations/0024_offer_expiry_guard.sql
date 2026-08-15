-- 0024: offer expiry guard (PR #17 review) — the MEMBER confirm/decline path must
-- enforce offer_expires_at INSIDE the atomic resolution write, not only in a
-- TS-side pre-check (a tap racing the deadline could otherwise still commit).
--
-- apply_offer_resolution gains p_expiry_guard (default false):
--   * false → unchanged ops semantics. The expiry sweep passes outcome='expired'
--     with its own offer_expires_at <= p_now condition, and the Sunday-midnight
--     auto-approve legitimately confirms rows whose offer window (capped at
--     midnight) has just lapsed — an unconditional check would break it.
--   * true  → confirm/decline additionally require the offer to still be live.
--     The check sits in the same conditional UPDATE as the state write (one
--     statement, one row lock), and the nxt/ins CTEs key off `resolved`, so a
--     blocked resolution also offers no substitute and enqueues no notice.
--
-- Boundary: now >= offer_expires_at counts as expired — matching the UI's
-- "still active" condition offer_expires_at > now.
--
-- The result gains expired_blocked so callers can surface a typed offer_expired
-- (vs no_active_offer). That flag is classification only, read after the guarded
-- UPDATE; a concurrent writer can at worst skew the label, never the state.

drop function if exists apply_offer_resolution(uuid,uuid,text,timestamptz,jsonb,jsonb,jsonb);

create function apply_offer_resolution(
  p_event_id uuid,
  p_offer_id uuid,
  p_outcome  text,     -- 'confirmed' | 'expired' | 'declined'
  p_now      timestamptz,
  p_approved jsonb,    -- for 'confirmed': {approved_at, release_deadline_at}
  p_next     jsonb,    -- for expire/decline: substitute or null
  p_outbox   jsonb,
  p_expiry_guard boolean default false
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_resolved int; v_next int; v_outbox int; v_expired_blocked boolean := false;
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
      and (not p_expiry_guard or p_outcome = 'expired'
           or r.offer_expires_at is null or r.offer_expires_at > p_now)
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

  if p_expiry_guard and v_resolved = 0 then
    select exists(
      select 1 from reservations
      where id = p_offer_id and status = 'temp_approved'
        and offer_expires_at is not null and offer_expires_at <= p_now
    ) into v_expired_blocked;
  end if;

  return jsonb_build_object('resolved', v_resolved, 'next_applied', v_next,
                            'outbox_enqueued', v_outbox, 'expired_blocked', v_expired_blocked);
end $$;

revoke all on function apply_offer_resolution(uuid,uuid,text,timestamptz,jsonb,jsonb,jsonb,boolean) from public;
grant execute on function apply_offer_resolution(uuid,uuid,text,timestamptz,jsonb,jsonb,jsonb,boolean) to service_role;
