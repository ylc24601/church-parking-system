-- Staff on-site check-in fixtures — DEV / LOCAL ONLY. NEVER run against production.
-- Phase 9 Slice 3.5 (Slice B) presentation verification: populate /staff with a list
-- that exercises every visual case — left-stripe precedence, the status + 優先 badges,
-- the mutually-exclusive count bar (已到/未到/已釋出/現場 sum = total), and 請移車
-- enabled/disabled. Presentation-only: just data, no route/API/schema changes.
--
-- Unlike the member fixture, run this WHOLE file ONCE (after `npm run db:reset`) — it
-- builds one fully-populated roster. Then: `npm run staff:set-pin` (issues a PIN for the
-- event), open /staff, log in with that PIN. Restore with `npm run db:reset`.
--
-- Seed refs (supabase/seed.sql): event = e0000000-…-0001; member reservations
-- c0000000-…-0001..0005 (members a0000000-…-0001..0005 all have line_id → owner_notifiable=true).
-- staff_checkin_view: is_priority = effective_priority <= 2; owner_notifiable = users.line_id is not null.
-- Shown statuses (STAFF_CHECKIN_STATUSES): approved, released_late, attended, attended_after_release, walk_in.

\set ev '''e0000000-0000-0000-0000-000000000001'''

-- ── SETUP: move the seed event onto the upcoming Sunday + open it ──────────────
with taipei_today as (
  select (now() at time zone 'Asia/Taipei')::date as d
),
upcoming_sunday as (
  select d + ((7 - extract(dow from d)::int) % 7) as sunday_date from taipei_today
)
update weekly_events
set sunday_date = (select sunday_date from upcoming_sunday), status = 'open'
where id = :ev;

-- ── Roster (member rows; owner_notifiable = true) ─────────────────────────────
-- 一般 approved 未到（neutral 色條、未到 badge、點名鈕、請移車 enabled）
update reservations set status='approved', effective_priority=3, attended_at=null
  where id = 'c0000000-0000-0000-0000-000000000001';
-- priority approved 未到（⭐ 優先 badge、neutral 色條、點名、請移車 enabled）
update reservations set status='approved', effective_priority=2, attended_at=null
  where id = 'c0000000-0000-0000-0000-000000000002';
-- attended（success 色條、已到 badge＋時間、列淡化）
update reservations set status='attended', effective_priority=3, attended_at=now()
  where id = 'c0000000-0000-0000-0000-000000000003';
-- attended_after_release（success 色條、已到（補）badge）
update reservations set status='attended_after_release', effective_priority=3, attended_at=now()
  where id = 'c0000000-0000-0000-0000-000000000004';
-- released_late（warning 色條、已釋出 badge、補點名鈕）
update reservations set status='released_late', effective_priority=3, attended_at=null
  where id = 'c0000000-0000-0000-0000-000000000005';

-- ── Walk-in row (no user → owner_notifiable = false → 請移車 disabled；現場 badge/count) ──
-- 對齊 createWalkInReservation 的欄位；固定車牌，重跑前請先 db:reset。
insert into reservations
  (weekly_event_id, status, walk_in_license_plate, walk_in_name, effective_priority, applied_at, attended_at)
values
  (:ev, 'walk_in', 'WK-0001', '現場散客', 3, now(), now());

-- 預期計數列：已到 2（attended＋after_release）／未到 2（兩筆 approved）／已釋出 1／現場 1，加總 = 6。
-- 還原：npm run db:reset
