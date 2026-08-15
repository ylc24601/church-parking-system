-- Phase 4 Slice B — Staff「請車主移車」(move-car request).
--
-- The move-car action needs the Staff UI to know, per row, whether the car's owner is
-- reachable over LINE — WITHOUT ever exposing line_id (the privacy contract of
-- staff_checkin_view: name / plate / is_priority / status / attended_at only). So add one
-- more Staff-safe boolean projection, exactly like is_priority: owner_notifiable reveals only
-- "can this owner be pushed?" (member with a bound line_id), never the line_id itself.
--
-- Walk-ins have no user → owner_notifiable = false. CREATE OR REPLACE with the new column
-- appended at the end is legal (existing columns/order unchanged) and preserves the view's
-- grants (a replace, not a drop).
create or replace view staff_checkin_view as
select r.id                          as reservation_id,
       r.weekly_event_id,
       u.display_name,
       v.license_plate,
       r.walk_in_name,
       r.walk_in_license_plate,
       (r.effective_priority <= 2)    as is_priority,        -- ⭐ 優先車位, reason hidden
       r.status,
       r.attended_at,
       (u.line_id is not null)        as owner_notifiable     -- LINE-reachable owner? (no line_id leaked)
from reservations r
left join users u    on u.id = r.user_id
left join vehicles v on v.id = r.vehicle_id;
