-- Phase 8 Slice 8: pastoral-care alert resolution + admin-issued staff-PIN audit.
--
-- (1) pastoral_care_alerts grows the Admin resolution columns promised by 0008
--     ("resolved_*/note are written by a future Admin resolution flow" — this is it):
--     resolved_by_admin_id (admins live in admin_accounts, NOT users, so the legacy
--     resolved_by -> users(id) column stays unused/null forever — same precedent as
--     0025's decided_by_admin_id), counter_reset (whether this resolution also reset
--     the member's consecutive_no_show — together with resolved_at/resolved_by_admin_id
--     the alert row IS the audit trail policy requires for a manual reset), a note
--     length bound, and a resolution-shape check so a row can never be half-resolved.
-- (2) staff_sessions.created_by_admin_id — who issued the on-site PIN from the Admin
--     UI (legacy created_by -> users(id) stays for the CLI path).
-- (3) resolve_pastoral_alert — the atomic resolve(+optional counter reset) RPC.

-- ── (1) pastoral_care_alerts resolution columns ───────────────────────────────────
alter table pastoral_care_alerts
  add column resolved_by_admin_id uuid references admin_accounts(id),
  add column counter_reset boolean not null default false;

alter table pastoral_care_alerts add constraint pastoral_care_alerts_note_len_ck
  check (note is null or char_length(btrim(note)) between 1 and 200);

-- No half-resolved audit rows: an open alert carries NO resolution data; a resolved
-- alert always has resolved_at. (Legacy rows are all open with null resolution fields
-- — the resolution flow never existed before this migration — so this is safe to add.)
alter table pastoral_care_alerts add constraint pastoral_care_alerts_resolution_shape_ck
  check (
    (status = 'open' and resolved_at is null and resolved_by_admin_id is null and counter_reset = false)
    or
    (status = 'resolved' and resolved_at is not null)
  );

-- ── (2) staff_sessions: Admin-UI issuance audit ───────────────────────────────────
alter table staff_sessions
  add column created_by_admin_id uuid references admin_accounts(id);

-- ── (3) resolve_pastoral_alert — atomic resolve + optional counter reset ──────────
-- Row-locked, status-guarded: two admins racing to resolve the same alert -> exactly
-- one wins, the other gets a typed 'already_resolved'. When p_reset_counter, the
-- member's consecutive_no_show goes to 0 IN THE SAME TRANSACTION (no row = no-op:
-- a missing user_penalties row already means the counter is zero). penalty_score is
-- never touched, and nothing is written to the outbox — resolution is care, not a
-- notification event.
create or replace function resolve_pastoral_alert(
  p_alert_id       uuid,
  p_admin_id       uuid,
  p_note           text,        -- null = no note; else 1..200 after trim
  p_reset_counter  boolean,
  p_now            timestamptz
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_status  pastoral_care_alert_status;
begin
  -- Explicit null guards: under three-valued logic a NULL argument would silently
  -- pass a bare comparison guard instead of raising.
  if p_alert_id is null then raise exception 'p_alert_id is required'; end if;
  if p_admin_id is null then raise exception 'p_admin_id is required'; end if;
  if p_reset_counter is null then raise exception 'p_reset_counter is required'; end if;
  if p_now is null then raise exception 'p_now is required'; end if;
  if p_note is not null and char_length(btrim(p_note)) not between 1 and 200 then
    raise exception 'p_note must be 1..200 characters after trim';
  end if;

  select user_id, status into v_user_id, v_status
    from pastoral_care_alerts where id = p_alert_id for update;
  if not found then
    return jsonb_build_object('resolved', 0, 'reason', 'not_found');
  end if;
  if v_status <> 'open' then
    return jsonb_build_object('resolved', 0, 'reason', 'already_resolved');
  end if;

  update pastoral_care_alerts set
    status               = 'resolved',
    resolved_at          = p_now,
    resolved_by_admin_id = p_admin_id,
    note                 = nullif(btrim(p_note), ''),
    counter_reset        = p_reset_counter
  where id = p_alert_id;

  if p_reset_counter then
    update user_penalties set consecutive_no_show = 0 where user_id = v_user_id;
  end if;

  return jsonb_build_object('resolved', 1, 'reason', 'resolved', 'counter_reset', p_reset_counter);
end $$;

revoke all on function resolve_pastoral_alert(uuid, uuid, text, boolean, timestamptz) from public;
grant execute on function resolve_pastoral_alert(uuid, uuid, text, boolean, timestamptz) to service_role;
