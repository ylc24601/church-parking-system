-- Phase 1 migration 0003: infrastructure tables (notifications, jobs, staff PIN, audit).

-- ── notification_outbox (LINE notification idempotency) ──────────────────────────
-- next_retry_at is NOT NULL DEFAULT now() so a pending row is never skipped by a
-- dispatcher filter of `next_retry_at <= now()`.
create table notification_outbox (
  id               uuid primary key default gen_random_uuid(),
  dedupe_key       text not null unique,
  template_key     text not null,
  user_id          uuid references users(id),
  reservation_id   uuid references reservations(id),
  weekly_event_id  uuid not null references weekly_events(id),
  payload_json     jsonb not null default '{}',
  status           notification_status not null default 'pending',
  retry_count      int not null default 0 check (retry_count >= 0),
  next_retry_at    timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  sent_at          timestamptz
);

create index notification_outbox_dispatch_idx
  on notification_outbox (status, next_retry_at) where status in ('pending', 'retrying');

-- ── job_runs (scheduler idempotency + observability) ─────────────────────────────
-- unique (weekly_event_id, job_type): one record per scheduled job per event.
create table job_runs (
  id               uuid primary key default gen_random_uuid(),
  weekly_event_id  uuid not null references weekly_events(id),
  job_type         text not null,
  status           job_run_status not null,
  started_at       timestamptz not null default now(),
  finished_at      timestamptz,
  error_message    text,
  unique (weekly_event_id, job_type)
);

-- ── staff_sessions (on-site PIN login) ───────────────────────────────────────────
create table staff_sessions (
  id               uuid primary key default gen_random_uuid(),
  weekly_event_id  uuid not null references weekly_events(id),
  pin_hash         text not null,
  expires_at       timestamptz not null,
  failed_attempts  int not null default 0 check (failed_attempts >= 0),
  locked_at        timestamptz,
  created_by       uuid references users(id)
);

-- ── audit_logs (privileged actions) ──────────────────────────────────────────────
create table audit_logs (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid references users(id),
  action       text not null,
  target_type  text not null,
  target_id    uuid,
  before_value jsonb,
  after_value  jsonb,
  created_at   timestamptz not null default now()
);
