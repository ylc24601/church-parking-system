-- Wave 0 (#21): make import_member's P2 eligibility optional so a general member roster
-- (優先序 P1/P3) can be imported as plain user + vehicles WITHOUT a user_eligibility row.
--
-- Same signature as 0020 (p_reason stays p2_reason, now allowed to be NULL) → CREATE OR REPLACE,
-- grants preserved. Only the body changes:
--   * p_reason IS NOT NULL  → unchanged: upsert eligibility summary + dependents (P2 path).
--   * p_reason IS NULL      → general (P1/P3): write user + vehicles ONLY, never touch eligibility.
--     If the phone already had P2, that is REPORTED (retained_p2) but NEVER revoked here — eligibility
--     revocation is the review tool (#10), not a side effect of a roster import.
-- Existing P2 callers always pass a reason, so their behaviour is unchanged.
create or replace function import_member(
  p_name        text,
  p_phone       text,
  p_plates      text[],
  p_reason      p2_reason,       -- NULL = general roster member (no eligibility written)
  p_valid_until date,
  p_review_date date,
  p_dependents  jsonb,           -- [{"kind":"child","name":"A","birthdate":"2022-03-01"}, ...]
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
  v_retained_p2     boolean := false;
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

  -- vehicles (normalize the same way the generated column does) — always, for both profiles
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

  if p_reason is not null then
    -- ── P2 path (unchanged) — eligibility summary: primary dependent = first in the list ──
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
  else
    -- ── General (P1/P3) path — NO eligibility written. If the member already had P2, report it
    -- as retained (kept, not revoked). Works identically in dry-run and apply (read-only check).
    if v_user_id is not null then
      select true into v_retained_p2 from user_eligibility where user_id = v_user_id and p2_eligible;
      v_retained_p2 := coalesce(v_retained_p2, false);
    end if;
  end if;

  return jsonb_build_object(
    'status',           v_status,
    'vehicles_added',   v_vehicles_added,
    'dependents_added', v_deps_added,
    'plate_conflicts',  to_jsonb(v_plate_conflicts),
    'retained_p2',      v_retained_p2
  );
end $$;

revoke all on function import_member(text, text, text[], p2_reason, date, date, jsonb, boolean) from public;
grant execute on function import_member(text, text, text[], p2_reason, date, date, jsonb, boolean) to service_role;
