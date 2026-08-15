-- Phase 3 v2 P1: Staff walk-in registration.
-- Race-safe dedupe for walk-ins: no two walk_in rows with the same normalized plate
-- in one event (two devices registering the same car at once). The normalization
-- expression mirrors vehicles.license_plate_normalized (0001): upper + strip non-alnum.
--
-- NOTE: this index only guards walk_in-vs-walk_in. Collisions with a plate already on
-- the on-site list (e.g. an approved member's vehicle) are caught by an app-layer
-- precheck in walkInService (it reads the Staff-safe staff_checkin_view).

create unique index reservations_walkin_plate_per_event
  on reservations (weekly_event_id,
                   upper(regexp_replace(walk_in_license_plate, '[^A-Za-z0-9]', '', 'g')))
  where status = 'walk_in';
