-- Phase 6 Slice 1: member import (church P2 application CSV → users + vehicles + eligibility).
-- CLI-first data foundation (Admin UI wraps it later). Imports member RECORDS only; line_id stays
-- NULL — binding attaches it later (Phase 5A/5B). The church application CSV is P2-only; P3/general
-- members self-onboard via the member UI. See docs/delivery-model-and-roadmap.md.

-- ── dependents ──────────────────────────────────────────────────────────────────────────────────
-- The form allows several children born years apart, but user_eligibility holds only a single
-- dependent summary. eligibility_dependents stores the per-dependent evidence; user_eligibility
-- keeps the *current summary* (primary dependent + the eligibility window).
create type dependent_kind as enum ('impaired', 'child', 'elder');

create table eligibility_dependents (
  id                  uuid           primary key default gen_random_uuid(),
  user_id             uuid           not null references users(id) on delete cascade,
  dependent_kind      dependent_kind not null,
  dependent_name      text           not null,
  dependent_birthdate date,
  note                text,
  created_at          timestamptz    not null default now()
);

-- Idempotent re-import: same dependent (kind+name+birthdate) collapses. NULL birthdate normalized so
-- it participates in uniqueness.
create unique index eligibility_dependents_uq
  on eligibility_dependents (user_id, dependent_kind, dependent_name, coalesce(dependent_birthdate, '0001-01-01'));

alter table eligibility_dependents enable row level security;
revoke all on eligibility_dependents from anon, authenticated;
grant select, insert, update, delete on eligibility_dependents to service_role;

-- ── member identity = phone ─────────────────────────────────────────────────────────────────────
-- The import keys members by mobile phone. Enforce it so two members can't share a phone (nulls
-- allowed: Admin/Staff/walk-in owners created without a phone).
create unique index users_phone_key on users (phone_number) where phone_number is not null;

-- ── import_member — atomic, typed, dry-run aware ─────────────────────────────────────────────────
-- Upserts one member (by phone) + their vehicles + P2 eligibility summary + dependents in one
-- transaction. Typed, non-throwing outcomes:
--   * phone exists with a DIFFERENT name        → {status:'phone_name_conflict'} (no writes)
--   * a plate already owned by ANOTHER member    → that plate reported in plate_conflicts, skipped
--   * else                                       → {status:'imported'|'updated'}
-- p_dry_run=true computes the same outcome (incl. conflict detection) WITHOUT writing. Counts are
-- projected in dry-run (dependents_added is an upper bound for an existing member).
create or replace function import_member(
  p_name        text,
  p_phone       text,
  p_plates      text[],
  p_reason      p2_reason,
  p_valid_until date,
  p_review_date date,
  p_dependents  jsonb,       -- [{"kind":"child","name":"A","birthdate":"2022-03-01"}, ...]
  p_dry_run     boolean
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_user_id         uuid;
  v_existing_name   text;
  v_status          text;
  v_plate           text;
  v_norm            text;
  v_owner           uuid;
  v_vehicles_added  int := 0;
  v_plate_conflicts text[] := '{}';
  v_dep             jsonb;
  v_deps_added      int := 0;
  v_primary_name    text;
  v_primary_bd      date;
begin
  select id, display_name into v_user_id, v_existing_name from users where phone_number = p_phone;
  if found then
    if v_existing_name is distinct from p_name then
      return jsonb_build_object('status', 'phone_name_conflict', 'existing_name', v_existing_name);
    end if;
    v_status := 'updated';
  else
    v_status := 'imported';
    if not p_dry_run then
      insert into users (display_name, phone_number) values (p_name, p_phone) returning id into v_user_id;
    end if;
  end if;

  -- vehicles (normalize the same way the generated column does)
  if p_plates is not null then
    foreach v_plate in array p_plates loop
      v_norm := upper(regexp_replace(v_plate, '[^A-Za-z0-9]', '', 'g'));
      if v_norm = '' then continue; end if;
      select user_id into v_owner from vehicles where license_plate_normalized = v_norm;
      if found then
        if v_owner is distinct from v_user_id then
          v_plate_conflicts := array_append(v_plate_conflicts, v_norm);
        end if;  -- already owned by this member → no-op
      else
        v_vehicles_added := v_vehicles_added + 1;
        if not p_dry_run and v_user_id is not null then
          insert into vehicles (user_id, license_plate) values (v_user_id, v_plate);
        end if;
      end if;
    end loop;
  end if;

  -- eligibility summary: primary dependent = first in the list (null for pregnancy)
  if p_dependents is not null and jsonb_array_length(p_dependents) > 0 then
    v_primary_name := p_dependents->0->>'name';
    v_primary_bd   := nullif(p_dependents->0->>'birthdate', '')::date;
  end if;

  if not p_dry_run and v_user_id is not null then
    insert into user_eligibility (user_id, p2_eligible, p2_reason, p2_valid_until, p2_review_date, dependent_name, dependent_birthdate)
    values (v_user_id, true, p_reason, p_valid_until, p_review_date, v_primary_name, v_primary_bd)
    on conflict (user_id) do update set
      p2_eligible         = true,
      p2_reason           = excluded.p2_reason,
      p2_valid_until      = excluded.p2_valid_until,
      p2_review_date      = excluded.p2_review_date,
      dependent_name      = excluded.dependent_name,
      dependent_birthdate = excluded.dependent_birthdate;

    if p_dependents is not null then
      for v_dep in select value from jsonb_array_elements(p_dependents) as t(value) loop
        with ins as (
          insert into eligibility_dependents (user_id, dependent_kind, dependent_name, dependent_birthdate)
          values (v_user_id, (v_dep->>'kind')::dependent_kind, v_dep->>'name', nullif(v_dep->>'birthdate', '')::date)
          on conflict do nothing
          returning 1
        )
        select v_deps_added + (select count(*) from ins) into v_deps_added;
      end loop;
    end if;
  elsif p_dependents is not null then
    v_deps_added := jsonb_array_length(p_dependents);  -- dry-run projection
  end if;

  return jsonb_build_object(
    'status',           v_status,
    'vehicles_added',   v_vehicles_added,
    'dependents_added', v_deps_added,
    'plate_conflicts',  to_jsonb(v_plate_conflicts)
  );
end $$;

revoke all on function import_member(text, text, text[], p2_reason, date, date, jsonb, boolean) from public;
grant execute on function import_member(text, text, text[], p2_reason, date, date, jsonb, boolean) to service_role;
