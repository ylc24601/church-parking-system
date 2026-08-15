-- Phase 1 migration 0004: views + RLS / GRANT strategy.
-- Model: service-role + app-layer authz. RLS is defense-in-depth (deny-all for
-- anon/authenticated). The Next.js server uses the service key (bypasses RLS).

-- ── v_weekly_capacity_inputs (Seam 4: supplies inputs, NOT the formula) ──────────
-- The arithmetic stays in the Phase 0 pure computeCapacity (single source of the
-- formula). App reads a row and calls computeCapacity(row, active_full_time_staff_reserved).
create view v_weekly_capacity_inputs as
select we.id            as weekly_event_id,
       we.total_capacity,
       we.blocked_spaces,
       we.admin_reserved,
       coalesce(s.active, 0) as active_full_time_staff_reserved
from weekly_events we
left join (
  select weekly_event_id, count(*) as active
  from weekly_staff_allocations
  where status = 'reserved'
  group by weekly_event_id
) s on s.weekly_event_id = we.id;

-- ── staff_checkin_view (privacy projection — development_plan §9) ────────────────
-- Exposes only name / plate / is_priority boolean / status / attended_at.
-- NEVER exposes p2_reason, penalty, or the raw effective_priority value.
-- Caller filters by weekly_event_id.
create view staff_checkin_view as
select r.id                          as reservation_id,
       r.weekly_event_id,
       u.display_name,
       v.license_plate,
       r.walk_in_name,
       r.walk_in_license_plate,
       (r.effective_priority <= 2)    as is_priority,   -- ⭐ 優先車位, reason hidden
       r.status,
       r.attended_at
from reservations r
left join users u    on u.id = r.user_id
left join vehicles v on v.id = r.vehicle_id;

-- ── RLS: enable on every table, add no permissive policies → default deny ─────────
alter table users                    enable row level security;
alter table user_eligibility         enable row level security;
alter table user_penalties           enable row level security;
alter table vehicles                 enable row level security;
alter table weekly_events            enable row level security;
alter table weekly_staff_allocations enable row level security;
alter table reservations             enable row level security;
alter table notification_outbox      enable row level security;
alter table job_runs                 enable row level security;
alter table staff_sessions           enable row level security;
alter table audit_logs               enable row level security;

-- ── GRANT strategy: revoke everything from client roles in Phase 1 ────────────────
-- service_role bypasses RLS and is how the server reads/writes. anon/authenticated
-- get nothing (defense-in-depth). Sensitive tables must never be client-reachable.
revoke all on all tables in schema public from anon, authenticated;

-- staff_checkin_view exists now; GRANT SELECT is deferred until a Staff-scoped path
-- (Phase 3). Its column projection is the contract that hides reasons/penalties.
revoke all on v_weekly_capacity_inputs from anon, authenticated;
revoke all on staff_checkin_view       from anon, authenticated;

-- service_role is the only DB principal in Phase 1/2 (the server uses it; it bypasses
-- RLS). This build's default privileges grant the API roles only Dxtm, so DML must be
-- granted to service_role explicitly. This also covers v_weekly_capacity_inputs.
grant select, insert, update, delete on all tables in schema public to service_role;
