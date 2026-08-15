-- Phase 1 dev seed (run by `supabase db reset`; NEVER in production).
-- Deterministic: fixed UUIDs and a fixed Sunday (2026-06-21, the same week as the
-- Phase 0 T fixtures) so db reset + verify_schema.sql are fully reproducible.

-- ── Users ────────────────────────────────────────────────────────────────────
-- admin / staff / full-time staff are backoffice-created → line_id NULL.
insert into users (id, line_id, phone_number, display_name, role) values
  ('11111111-1111-1111-1111-111111111111', null,         '0900000001', '辦公室幹事', 'admin'),
  ('22222222-2222-2222-2222-222222222222', null,         '0900000002', '停車同工',   'staff'),
  ('33333333-3333-3333-3333-333333333333', null,         '0900000003', '全職同工A',  'full_time_staff'),
  ('44444444-4444-4444-4444-444444444444', null,         '0900000004', '全職同工B',  'full_time_staff'),
  ('a0000000-0000-0000-0000-000000000001', 'U_member_01', '0911000001', '會友一', 'user'),
  ('a0000000-0000-0000-0000-000000000002', 'U_member_02', '0911000002', '會友二', 'user'),
  ('a0000000-0000-0000-0000-000000000003', 'U_member_03', '0911000003', '會友三', 'user'),
  ('a0000000-0000-0000-0000-000000000004', 'U_member_04', '0911000004', '會友四', 'user'),
  ('a0000000-0000-0000-0000-000000000005', 'U_member_05', '0911000005', '會友五', 'user');

-- ── Vehicles (one per member; distinct normalized plates) ─────────────────────
insert into vehicles (id, user_id, license_plate, nickname) values
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'ABC-1234', '家庭車'),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'DEF 5678', null),
  ('b0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', 'GHI-9012', null),
  ('b0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000004', 'JKL-3456', null),
  ('b0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000005', 'MNO-7890', null);

-- ── Eligibility (sensitive) ────────────────────────────────────────────────────
-- review_status is the authority since 0032; p2_eligible is generated from it and
-- cannot be written. child_companion carries the youngest child's birthdate, and the
-- expiry derives from it via the Aug-31 school-year cohort rule: born 2022-03-01 →
-- enters school Sept 2028 → last eligible 2028-08-31.
insert into user_eligibility (user_id, review_status, p2_reason, p2_child_birthdate, p2_valid_until, p2_review_date, dependent_name, dependent_birthdate) values
  ('a0000000-0000-0000-0000-000000000001', 'approved', 'mobility_long',   null,         null,         null,         null,    null),
  ('a0000000-0000-0000-0000-000000000002', 'approved', 'child_companion', '2022-03-01', '2028-08-31', '2028-08-31', '小寶',  '2022-03-01');

-- ── Penalties (default clean record per member) ──────────────────────────────
insert into user_penalties (user_id) values
  ('a0000000-0000-0000-0000-000000000001'),
  ('a0000000-0000-0000-0000-000000000002'),
  ('a0000000-0000-0000-0000-000000000003'),
  ('a0000000-0000-0000-0000-000000000004'),
  ('a0000000-0000-0000-0000-000000000005');

-- ── Weekly event (fixed Sunday) ──────────────────────────────────────────────
-- blocked_spaces was 1 + admin_reserved 2 until 0031 folded the two into a single
-- 「保留·停用」number (admin_reserved is now CHECK-pinned to 0). Arithmetic is
-- unchanged — 23−1−2−1staff and 23−3−0−1staff both give an effective capacity of 19 —
-- so every downstream expectation that depended on this seed still holds.
insert into weekly_events (id, sunday_date, total_capacity, blocked_spaces, admin_reserved, status) values
  ('e0000000-0000-0000-0000-000000000001', '2026-06-21', 23, 3, 0, 'open');

-- ── P1 weekly state: A reserved, B skipped → active_full_time_staff_reserved = 1 ─
-- The question is "does this staff member need one of the system-managed 23 spaces this
-- week?", not "are they at church?" — staff normally use the church-managed area, which is
-- outside this system and never counted. So A (has to leave early, so that area does not
-- work this week) holds one of the 23, while B attends but parks there and holds none.
insert into weekly_staff_allocations (weekly_event_id, user_id, status, skip_reason) values
  ('e0000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'reserved', null),
  ('e0000000-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'skipped',  '停教會自管停車區');

-- ── Reservations: P2/P3 mix (pending) + one walk-in ──────────────────────────
insert into reservations
  (id, weekly_event_id, user_id, vehicle_id, requested_p2_this_week, effective_priority, status, applied_at)
values
  ('c0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000001', false, 2, 'pending', '2026-06-15T01:00:00Z'),
  ('c0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', true,  2, 'pending', '2026-06-15T01:05:00Z'),
  ('c0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000003', false, 3, 'pending', '2026-06-15T01:10:00Z'),
  ('c0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000004', false, 3, 'pending', '2026-06-15T01:15:00Z'),
  ('c0000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-000000000001',
   'a0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000005', false, 3, 'pending', '2026-06-15T01:20:00Z');

-- Walk-in: no account/vehicle, plate required.
insert into reservations
  (id, weekly_event_id, user_id, vehicle_id, walk_in_name, walk_in_license_plate, effective_priority, status)
values
  ('c0000000-0000-0000-0000-0000000000ff', 'e0000000-0000-0000-0000-000000000001',
   null, null, '現場散客', 'WALK-0001', 3, 'walk_in');
