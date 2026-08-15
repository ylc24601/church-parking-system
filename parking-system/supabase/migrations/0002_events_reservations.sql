-- Phase 1 migration 0002: weekly events, P1 weekly state, and reservations.

-- ── weekly_events ──────────────────────────────────────────────────────────────
-- admin_reserved == guest_reserved (外賓保留位). total_capacity default 23 mirrors
-- rules.DEFAULT_TOTAL_CAPACITY. P1 full-time staff are counted via
-- weekly_staff_allocations, not here.
create table weekly_events (
  id              uuid primary key default gen_random_uuid(),
  sunday_date     date not null unique,
  total_capacity  int not null default 23 check (total_capacity >= 0),
  blocked_spaces  int not null default 0 check (blocked_spaces >= 0),
  admin_reserved  int not null default 0 check (admin_reserved >= 0),
  status          weekly_event_status not null default 'open'
);

comment on column weekly_events.admin_reserved is 'guest_reserved (外賓保留位); P1 staff counted separately via weekly_staff_allocations';

-- ── weekly_staff_allocations (P1 weekly state; replaces users.p1_skip_this_week) ─
create table weekly_staff_allocations (
  id               uuid primary key default gen_random_uuid(),
  weekly_event_id  uuid not null references weekly_events(id) on delete cascade,
  user_id          uuid not null references users(id),
  status           weekly_staff_allocation_status not null default 'reserved',
  skip_reason      text,
  updated_at       timestamptz not null default now(),
  unique (weekly_event_id, user_id)
);

-- active_full_time_staff_reserved = count(status='reserved'); index supports it.
create index weekly_staff_allocations_active_idx
  on weekly_staff_allocations (weekly_event_id) where status = 'reserved';

-- ── reservations ──────────────────────────────────────────────────────────────
create table reservations (
  id                      uuid primary key default gen_random_uuid(),
  weekly_event_id         uuid not null references weekly_events(id),
  user_id                 uuid,          -- null for walk_in
  vehicle_id              uuid,          -- null for walk_in
  walk_in_name            text,
  walk_in_license_plate   text,
  requested_p2_this_week  boolean not null default false,
  effective_priority      smallint not null check (effective_priority in (1, 2, 3)),
  status                  reservation_status not null default 'pending',
  -- offer (substitution) sub-state
  offer_status            offer_status,  -- null = none
  last_offer_at           timestamptz,
  offer_expires_at        timestamptz,
  -- P2 release timing
  p2_on_the_way           boolean not null default false,
  release_deadline_at     timestamptz,
  -- frozen waiting-order snapshot (set at Friday 18:00 allocation)
  allocation_order        int,
  -- lifecycle timestamps
  applied_at              timestamptz not null default now(),
  approved_at             timestamptz,
  attended_at             timestamptz,
  released_at             timestamptz,
  cancelled_at            timestamptz,
  finalized_at            timestamptz,
  -- notes
  staff_note              text,
  admin_note              text,

  -- user_id FK
  constraint reservations_user_fk foreign key (user_id) references users(id),
  -- Seam 3: a member's vehicle must belong to that same user. MATCH SIMPLE means
  -- the FK is skipped when either column is null (walk-in), and enforced when both
  -- are present (member rows, guaranteed by the member-shape check below).
  constraint reservations_vehicle_owner_fk
    foreign key (vehicle_id, user_id) references vehicles(id, user_id),

  -- Seam 1: every approved row must carry its computed release deadline.
  constraint reservations_approved_has_deadline
    check (status <> 'approved' or release_deadline_at is not null),
  -- walk-in shape
  constraint reservations_walkin_shape
    check (status <> 'walk_in'
           or (user_id is null and vehicle_id is null and walk_in_license_plate is not null)),
  -- member shape (non walk-in must have both user and vehicle)
  constraint reservations_member_shape
    check (status = 'walk_in' or (user_id is not null and vehicle_id is not null))
);

-- Seam 2: next substitution candidate — WHERE status='waiting' ORDER BY allocation_order ASC.
create index reservations_waiting_order_idx
  on reservations (weekly_event_id, allocation_order) where status = 'waiting';

-- Frozen-rank integrity: no duplicate allocation_order within a week.
create unique index reservations_allocation_order_key
  on reservations (weekly_event_id, allocation_order) where allocation_order is not null;

-- One active reservation per member per week (PRD §四.1); cancelled rows excluded.
create unique index reservations_one_active_per_member
  on reservations (weekly_event_id, user_id)
  where user_id is not null and status not in ('cancelled_by_user', 'cancelled_late');

-- Release scan: find approved rows due for release.
create index reservations_release_scan_idx
  on reservations (weekly_event_id, release_deadline_at) where status = 'approved';
