-- Phase 5A: LINE webhook → pending binding capture.
-- The dispatcher can only reach a member once users.line_id is populated, and a LINE userId
-- can ONLY be obtained from a webhook/LIFF event — never from the OA console. This slice adds
-- the capture side: a member who has added the OA sends `綁定 <code>` / `bind <code>`; the
-- webhook records a PENDING claim here. It does NOT write users.line_id — a later slice (5B)
-- approves a pending row into users.line_id, respecting users_line_id_key.
--
-- Privacy: line_user_id + submitted_code live here (this is the whole point), but they must
-- never leak into logs / errors / notification_outbox.last_error. The capture RPC returns
-- counts only.

-- One row per LINE account while it is an unapproved claim. `status` is forward-compatible with
-- Slice 5B's approve/reject; only 'pending' is ever written in 5A. superseded_count /
-- last_submitted_at / last_event_type give minimal auditability when a chatty member re-sends
-- (the active row is upserted in place instead of flooding the table).
create table pending_binding (
  id                uuid primary key default gen_random_uuid(),
  line_user_id      text        not null,
  submitted_code    text        not null,               -- normalized (trim + uppercase), matches ^[A-Z0-9-]{4,16}$
  status            text        not null default 'pending'
                      check (status in ('pending', 'approved', 'rejected')),
  last_event_type   text        not null,               -- 'message' (only source of a claim in 5A)
  superseded_count  int         not null default 0,     -- times the active pending row was re-submitted
  created_at        timestamptz not null default now(),
  last_submitted_at timestamptz not null default now()
);

-- At most one ACTIVE (pending) claim per LINE account — the upsert target for re-sends.
create unique index pending_binding_active_uq on pending_binding (line_user_id) where status = 'pending';

-- pending_binding is created AFTER 0004's one-time blanket grant, so privileges must be set
-- explicitly here. RLS deny-all + service_role (which bypasses RLS) is the only DB principal.
alter table pending_binding enable row level security;
revoke all on pending_binding from anon, authenticated;
grant select, insert, update, delete on pending_binding to service_role;

-- Atomic capture: insert a new pending claim, or upsert the member's existing active claim
-- (new code wins, superseded_count++). ON CONFLICT on the partial unique index makes concurrent
-- re-sends safe (no read-modify-write race). `xmax <> 0` distinguishes an update from an insert
-- so the caller can count supersedes. Returns counts only — never the userId or code.
create or replace function capture_pending_binding(
  p_line_user_id text,
  p_code         text,
  p_event_type   text,
  p_now          timestamptz
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_was_update boolean;
begin
  insert into pending_binding (line_user_id, submitted_code, status, last_event_type, created_at, last_submitted_at)
  values (p_line_user_id, p_code, 'pending', p_event_type, p_now, p_now)
  on conflict (line_user_id) where status = 'pending'
  do update set
    submitted_code    = excluded.submitted_code,
    last_event_type   = excluded.last_event_type,
    last_submitted_at = p_now,
    superseded_count  = pending_binding.superseded_count + 1
  returning (xmax <> 0) into v_was_update;

  return jsonb_build_object('captured', 1, 'superseded', coalesce(v_was_update, false));
end $$;

revoke all on function capture_pending_binding(text, text, text, timestamptz) from public;
grant execute on function capture_pending_binding(text, text, text, timestamptz) to service_role;
