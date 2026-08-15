-- Phase 1 migration 0001: enum types + core identity tables.
-- Source of truth: docs/development_plan.md §2 and Phase 0 lib/types.ts.

-- ── Enum types (mirror the Phase 0 union types exactly) ──────────────────────
create type user_role as enum ('user', 'full_time_staff', 'staff', 'admin');

create type p2_reason as enum (
  'mobility_long', 'mobility_short', 'pregnancy', 'elderly_companion', 'child_companion'
);

create type weekly_event_status as enum ('open', 'closed', 'finalized');

create type weekly_staff_allocation_status as enum ('reserved', 'skipped', 'attended', 'no_show');

-- Deliberately omits offer_expired / offer_declined (removed in Phase 0);
-- offer outcomes live in the nullable offer_status enum below.
create type reservation_status as enum (
  'pending', 'approved', 'temp_approved', 'waiting', 'attended', 'released_late',
  'attended_after_release', 'no_show', 'cancelled_by_user', 'cancelled_late', 'walk_in'
);

-- null on the column means "no offer history yet" (matches Phase 0 OfferStatus = null | ...).
create type offer_status as enum ('expired', 'declined');

create type notification_status as enum ('pending', 'sent', 'failed', 'retrying');

create type job_run_status as enum ('running', 'success', 'failed', 'skipped');

-- ── users ────────────────────────────────────────────────────────────────────
-- line_id is nullable: Admin/Staff/P1 are created in the backoffice before any
-- LINE binding. Uniqueness is enforced only over non-null values.
create table users (
  id            uuid primary key default gen_random_uuid(),
  line_id       text,
  phone_number  text,
  display_name  text not null,
  role          user_role not null default 'user',
  created_at    timestamptz not null default now()
);

create unique index users_line_id_key on users (line_id) where line_id is not null;

-- ── user_eligibility (sensitive; split from users per privacy design) ─────────
create table user_eligibility (
  user_id              uuid primary key references users(id) on delete cascade,
  p2_eligible          boolean not null default false,
  p2_reason            p2_reason,
  p2_valid_until       date,
  p2_review_date       date,
  dependent_name       text,
  dependent_birthdate  date,
  reviewed_by          uuid references users(id),
  reviewed_at          timestamptz,
  constraint eligibility_reason_present
    check (p2_eligible = false or p2_reason is not null)
);

-- ── user_penalties (sensitive) ────────────────────────────────────────────────
-- penalty_score cap 3 mirrors rules.MAX_PENALTY.
create table user_penalties (
  user_id                      uuid primary key references users(id) on delete cascade,
  penalty_score                int not null default 0 check (penalty_score between 0 and 3),
  consecutive_no_show          int not null default 0 check (consecutive_no_show >= 0),
  last_successful_attended_at  date
);

-- ── vehicles ──────────────────────────────────────────────────────────────────
-- Uniqueness is on the normalized plate so ABC-1234 / ABC1234 / abc-1234 collapse
-- to one. The composite unique (id, user_id) backs the reservations composite FK.
create table vehicles (
  id                        uuid primary key default gen_random_uuid(),
  user_id                   uuid not null references users(id),
  license_plate             text not null,
  license_plate_normalized  text generated always as
                              (upper(regexp_replace(license_plate, '[^A-Za-z0-9]', '', 'g'))) stored,
  nickname                  text,
  is_active                 boolean not null default true,
  created_at                timestamptz not null default now(),
  unique (id, user_id)
);

create unique index vehicles_plate_normalized_key on vehicles (license_plate_normalized);
