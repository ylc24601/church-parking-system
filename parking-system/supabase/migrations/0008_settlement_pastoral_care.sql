-- Phase 2 slice 4: settle / no-show + pastoral-care alerts.
-- Conventions match 0005-0007: SET search_path, REVOKE FROM public + GRANT to service_role,
-- status-guarded UPDATEs for idempotency, side effects joined to the rows actually transitioned.

-- ── Enums ────────────────────────────────────────────────────────────────────────
-- Only the consecutive-no-show trigger ships now; the two §7 daily-scheduler reasons
-- (mobility_short review-due / child aging-out) are added with their own slice later.
create type pastoral_care_reason as enum ('consecutive_no_show');
create type pastoral_care_alert_status as enum ('open', 'resolved');

-- ── pastoral_care_alerts (sensitive; never exposed to Staff) ──────────────────────
-- Independent table by design — the flag does NOT live on user_penalties. resolved_*/note
-- are written by a future Admin resolution flow (out of scope here; stay null for now).
create table pastoral_care_alerts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references users(id),
  weekly_event_id  uuid not null references weekly_events(id),   -- which week triggered it
  reason           pastoral_care_reason not null,
  trigger_count    int not null,                                  -- snapshot of consecutive_no_show
  status           pastoral_care_alert_status not null default 'open',
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz,
  resolved_by      uuid references users(id),
  note             text
);

-- At most one OPEN alert per user, regardless of reason/week (MVP decision). Backs
-- `ON CONFLICT (user_id) WHERE status='open' DO NOTHING`; a new condition while one is
-- open is a no-op until Admin resolves the existing alert.
create unique index pastoral_care_alerts_one_open
  on pastoral_care_alerts (user_id) where status = 'open';

-- RLS deny-all (defense-in-depth) + explicit service_role DML. A table created here is NOT
-- covered by 0004's point-in-time `grant ... on all tables` (development_plan §12 finding).
alter table pastoral_care_alerts enable row level security;
revoke all on pastoral_care_alerts from anon, authenticated;
grant select, insert, update, delete on pastoral_care_alerts to service_role;

-- ── Settle sweep: released_late → no_show + penalty + pastoral alert, atomic ──────
-- The service computes settleNoShow() in TS; this RPC applies the results. No outbox:
-- pastoral notification routing arrives with the Admin UI / dispatcher later.
create or replace function apply_settlement(
  p_event_id  uuid,
  p_now       timestamptz,
  p_penalties jsonb,   -- [{user_id,penalty_score,consecutive_no_show,last_successful_attended_at}]
  p_alerts    jsonb    -- [{user_id,reason,trigger_count}] — flagged users only
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_settled int; v_penalties int; v_alerts int;
begin
  with settled as (   -- status-guarded batch: released_late → no_show
    update reservations set status = 'no_show'
    where weekly_event_id = p_event_id and status = 'released_late'
    returning id, user_id
  ),
  pens as (   -- penalty applied ONLY for users whose reservation actually transitioned this run
    insert into user_penalties (user_id, penalty_score, consecutive_no_show, last_successful_attended_at)
    select (e->>'user_id')::uuid, (e->>'penalty_score')::int, (e->>'consecutive_no_show')::int,
           (e->>'last_successful_attended_at')::date
    from jsonb_array_elements(p_penalties) e
    join settled s on s.user_id = (e->>'user_id')::uuid
    on conflict (user_id) do update set
      penalty_score       = excluded.penalty_score,
      consecutive_no_show = excluded.consecutive_no_show   -- last_successful_attended_at NOT touched
    returning user_id
  ),
  alerts as (   -- pastoral alert for flagged users, deduped on the open partial index
    insert into pastoral_care_alerts (user_id, weekly_event_id, reason, trigger_count, status, created_at)
    select (e->>'user_id')::uuid, p_event_id, (e->>'reason')::pastoral_care_reason,
           (e->>'trigger_count')::int, 'open', p_now
    from jsonb_array_elements(p_alerts) e
    join settled s on s.user_id = (e->>'user_id')::uuid
    on conflict (user_id) where status = 'open' do nothing
    returning id
  )
  select (select count(*) from settled), (select count(*) from pens), (select count(*) from alerts)
    into v_settled, v_penalties, v_alerts;

  return jsonb_build_object('settled', v_settled, 'penalties_applied', v_penalties, 'alerts_created', v_alerts);
end $$;

revoke all on function apply_settlement(uuid, timestamptz, jsonb, jsonb) from public;
grant execute on function apply_settlement(uuid, timestamptz, jsonb, jsonb) to service_role;
