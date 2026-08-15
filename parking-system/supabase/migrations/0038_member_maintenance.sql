-- Tier 0-2 — Admin member maintenance (pre-pilot maintenance closure).
--
-- Before this migration the ONLY way to write member data was the CSV import, which has
-- three structural consequences:
--   1. import_member keys members by PHONE. Re-importing a member whose phone changed does
--      not update them — it creates a SECOND users.id. The old row keeps the LINE binding,
--      reservation history, penalties and eligibility; the new one has none of it.
--   2. Vehicles are insert-only. `is_active` has existed since 0001 and every READER already
--      honours it, but nothing could ever set it false: a sold car's plate stays active
--      forever, and that is exactly what Staff check-in matches against.
--   3. Adding one member required a one-row CSV.
--
-- The single principle this migration enforces everywhere:
--
--     A member's identity is users.id. `phone_number` is a MUTABLE attribute and must never
--     act as identity across time.
--
-- ── What is in scope, and what is deliberately not ───────────────────────────────
-- The four NEW admin maintenance mutations at the bottom are audited SECURITY DEFINER RPCs.
-- The five existing RPCs replaced above them get ONLY the invariant / concurrency / lifecycle
-- fix this slice needs — their security, actor and compatibility contracts are untouched.
-- Do not "modernise" them while passing through: that expands scope and breaks the
-- old-app-plus-new-DB compatibility this migration is careful to preserve.
--
-- There is NO user-merge tool, by choice. See docs/member-import-ops.md for the residual risk.
--
-- ── Deployment: A is ALMOST safe — there is one narrow window. B is not safe. ────
--   A (old app + new DB) ⚠️ **almost** — every replaced function keeps its exact signature,
--     the identity guard reuses the EXISTING 'phone_name_conflict' discriminant (see
--     import_member) so an old client fails closed rather than miscounting a skipped member
--     as updated, and the snapshot column is additive with the capture/approval return
--     SHAPES unchanged.
--
--     The exception, stated plainly because a silent one is worse: this migration renames
--     the LIFF approval refusal 'phone_not_found' → 'unmatched_at_capture'. The currently
--     deployed app lists the accepted outcomes explicitly
--     (app/api/admin/bindings/approve/route.ts REVIEW_OUTCOMES) and 500s on anything else,
--     so between `db push` and Promote, approving a LIFF claim whose snapshot is null
--     returns a 500 to the operator.
--
--     NO data is at risk: the RPC's refusal is a typed return that writes nothing, and the
--     500 is the old route declining to render a reason it does not know. It is a
--     availability window on ONE admin action, not a correctness problem — the same shape
--     as 0035's reset_admin_password window (prod-deploy-runbook.md §1.5). Do not linger in
--     this state: run verify → staged smoke → Promote as one continuous operation.
--
--     The alternative — keep emitting 'phone_not_found' from the DB and rename only in the
--     UI — was rejected. The whole point of the snapshot is that this refusal no longer
--     means "no member has this phone NOW"; keeping the old wire name to save a few minutes
--     of window would preserve exactly the mental model this slice exists to delete.
--   B (new app + old DB) ❌ — the new app calls the four RPCs below, which do not exist yet.
--   R (previous production deployment + new DB) ⚠️ — same window as A, same reasoning.
-- ⇒ Production traffic order: old app + old DB → old app + new DB → new app + new DB.
--   The DB migration must land BEFORE the new app is promoted (prod-deploy-runbook.md §1.5).

-- ════════════════════════════════════════════════════════════════════════════════
-- (1) Name matching — ONE authority, used by both the generated column and every RPC
-- ════════════════════════════════════════════════════════════════════════════════
-- This is a FAIL-CLOSED CANDIDATE DETECTOR and nothing more. It is not an identity, it is
-- never written back to display_name, it is NOT unique, and it does not attempt homophone,
-- simplified/traditional or fuzzy matching. Its only job is "might these be the same person?
-- — ask a human".
--
-- Deliberately biased toward RECALL: over-merging costs one operator confirmation, while
-- under-merging costs a duplicate identity that this system has no tool to repair.
--
-- Whitespace is an EXPLICIT codepoint list rather than `\s` / `[[:space:]]`: those classes
-- are ctype-dependent for non-ASCII, which makes both true immutability (required for a
-- generated column) and "does U+3000 match?" environment-dependent.
--
-- Written with chr() rather than literal characters ON PURPOSE. NBSP and IDEOGRAPHIC SPACE
-- are INVISIBLE in source: a literal character class is unreviewable, and one careless editor
-- save or copy-paste turns them into ordinary spaces with nothing to show for it in the diff.
-- translate() with an empty replacement deletes every listed character, which is exactly the
-- intent and needs no regex at all.
--
-- NFKC already folds U+00A0 and U+3000 to U+0020, so they are belt-and-braces here. They stay
-- listed because depending on that folding silently would leave the next reader guessing.
create function normalize_member_name_for_match(p_name text) returns text
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select lower(
    translate(
      normalize(p_name, NFKC),
      chr(9) || chr(10) || chr(13) || chr(32) || chr(160) || chr(12288),  -- tab LF CR SP NBSP U+3000
      ''))
$$;

comment on function normalize_member_name_for_match(text) is
  'Fail-closed name candidate key. NOT an identity, NOT unique, no fuzzy matching. Single '
  'authority: users.member_name_match_key and every RPC lookup must go through this function.';

alter table users
  add column member_name_match_key text
    generated always as (normalize_member_name_for_match(display_name)) stored;

-- NON-unique on purpose: two members legitimately share a name. Uniqueness here would be a
-- data-integrity claim the domain does not support.
create index users_name_match_key_idx on users (member_name_match_key);

-- ════════════════════════════════════════════════════════════════════════════════
-- (2) LIFF binding claims — resolve identity at CAPTURE, not at approval
-- ════════════════════════════════════════════════════════════════════════════════
-- The hole this closes: capture_liff_binding_claim stores only claimed_phone, and
-- approve_pending_binding resolved phone → user at APPROVAL time. Once an admin can change a
-- phone, that is a cross-identity binding waiting to happen:
--
--     A's phone P1 → P2 (P1 is now free)
--     A's LINE re-submits the OLD phone P1  → a fresh pending(P1) is captured
--     new member B is created with P1
--     admin approves that claim → approval resolves P1 *now* → A's LINE binds to B
--
-- Rejecting the claims that exist at the moment of the phone change is NOT enough: the
-- sequence above re-creates one afterwards. Nor is an advisory lock — this is an ordering
-- problem across time, not a concurrency problem. The fix is to freeze the answer at capture.
alter table pending_binding
  add column matched_user_id_at_capture uuid references users(id);

comment on column pending_binding.matched_user_id_at_capture is
  'The member this claim matched WHEN IT WAS CAPTURED (null = matched nobody). Approval uses '
  'this and never re-resolves claimed_phone, so a later phone reassignment cannot retarget it.';

-- Backfill is correct here precisely BECAUSE no phone-mutation path has ever existed: the
-- phone → user mapping has not changed since each row was written, so resolving now is
-- identical to resolving at capture. This argument expires the moment this migration lands.
update pending_binding
   set matched_user_id_at_capture = u.id
  from users u
 where pending_binding.claim_source = 'liff'
   and pending_binding.claimed_phone is not null
   and u.phone_number = pending_binding.claimed_phone;

-- The snapshot is claim-time IDENTITY data, so it obeys the SAME shapes as the rest of the
-- claim: a keyword row must not carry one, and a redacted row must not keep one.
alter table pending_binding drop constraint pending_binding_claim_shape_ck;
alter table pending_binding add constraint pending_binding_claim_shape_ck check (
  (claim_source = 'keyword' and submitted_code is not null
     and claimed_phone is null and claimed_name is null
     and matched_user_id_at_capture is null)
  or
  (claim_source = 'liff' and submitted_code is null
     and claimed_phone is not null and claimed_name is not null)
  or
  (status in ('approved', 'rejected')
     and submitted_code is null and claimed_phone is null and claimed_name is null
     and matched_user_id_at_capture is null)
);

-- ════════════════════════════════════════════════════════════════════════════════
-- (3) Retention — the snapshot is claim-time PII and expires with the rest of it
-- ════════════════════════════════════════════════════════════════════════════════
-- 0027's policy: 90 days after a decision, clear the claim data and keep only the FACT of the
-- claim and how it was decided (claim_source, timestamps, status, approved_user_id,
-- rejected_reason, decided_by_admin_id).
--
-- matched_user_id_at_capture is claim-time identity data too. Leaving it behind would
-- silently widen that policy: every decided LIFF row would keep a permanent
-- pending_binding → member link. An approved row already records the outcome in
-- approved_user_id, so the snapshot is redundant there; a rejected row should certainly not
-- keep one. Same signature → CREATE OR REPLACE, grants preserved.
create or replace function redact_decided_binding_pii(
  p_now             timestamptz,
  p_retention_days  int,
  p_max             int,
  p_dry_run         boolean
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_cutoff timestamptz;
  v_count  int;
begin
  if p_now is null then
    raise exception 'p_now is required';
  end if;
  if p_retention_days is null or p_retention_days < 30 then
    raise exception 'p_retention_days must be an integer >= 30';
  end if;
  if p_max is null or p_max < 1 or p_max > 500 then
    raise exception 'p_max must be between 1 and 500';
  end if;
  if p_dry_run is null then
    raise exception 'p_dry_run is required';
  end if;

  v_cutoff := p_now - make_interval(days => p_retention_days);

  -- "Still holds claim-time identity data" now has ONE definition, and the snapshot is part
  -- of it — otherwise a row whose three text columns were already cleared could keep its
  -- snapshot forever without ever matching the scan again.
  if p_dry_run then
    select count(*) from (
      select 1 from pending_binding
       where status in ('approved', 'rejected')
         and coalesce(approved_at, rejected_at) <= v_cutoff
         and (claimed_phone is not null or claimed_name is not null
              or submitted_code is not null or matched_user_id_at_capture is not null)
       limit p_max + 1
    ) probe into v_count;
    return jsonb_build_object(
      'count', least(v_count, p_max),
      'has_more', v_count > p_max
    );
  end if;

  with target as (
    select id from pending_binding
     where status in ('approved', 'rejected')
       and coalesce(approved_at, rejected_at) <= v_cutoff
       and (claimed_phone is not null or claimed_name is not null
            or submitted_code is not null or matched_user_id_at_capture is not null)
     order by coalesce(approved_at, rejected_at)
     limit p_max
     for update skip locked
  ),
  done as (
    update pending_binding b set
      claimed_phone              = null,
      claimed_name               = null,
      submitted_code             = null,
      matched_user_id_at_capture = null
    from target
    where b.id = target.id
    returning 1
  )
  select count(*) from done into v_count;
  return jsonb_build_object('count', v_count, 'has_more', false);
end $$;

-- The scan index must match the scan predicate, or the daily job stops using it.
drop index pending_binding_pii_retention_idx;
create index pending_binding_pii_retention_idx
  on pending_binding ((coalesce(approved_at, rejected_at)))
  where status in ('approved', 'rejected')
    and (claimed_phone is not null or claimed_name is not null
         or submitted_code is not null or matched_user_id_at_capture is not null);

-- ════════════════════════════════════════════════════════════════════════════════
-- (4) Vehicles — active-plate uniqueness, with history preserved
-- ════════════════════════════════════════════════════════════════════════════════
-- New invariant: AT MOST ONE ACTIVE row per normalized plate; any number of inactive
-- historical rows. That is what makes a plate re-issuable to a new owner without rewriting
-- history — reservations reference (vehicle_id, user_id), i.e. that car AND the owner at the
-- time, so changing an old row's owner would falsify the record.
--
-- Order matters: CREATE the partial index BEFORE dropping the global one. The global unique
-- index is the strictly stronger invariant, so the partial one is guaranteed to build, and
-- the two coexist harmlessly for an instant. The reverse order would open a window with no
-- protection at all if this ever stops running inside one transaction.
create unique index vehicles_active_plate_uq
  on vehicles (license_plate_normalized) where is_active;
drop index vehicles_plate_normalized_key;

-- ════════════════════════════════════════════════════════════════════════════════
-- (5) import_member — active-only plate lookup + identity guard
-- ════════════════════════════════════════════════════════════════════════════════
-- Two fixes, same signature (CREATE OR REPLACE, grants preserved):
--
-- (a) The plate owner lookup gained `and is_active`. With multiple rows now legal per plate,
--     the old unfiltered `SELECT ... INTO` would silently take an ARBITRARY row (plpgsql's
--     non-STRICT SELECT INTO does not error on multiple rows), making conflict detection
--     nondeterministic. `LIMIT 1` would be the wrong fix — it hides the ambiguity instead of
--     resolving it. Every "who owns this plate right now?" question is active-scoped.
--
-- (b) Identity guard. If the CSV's phone is NOT in the DB but the normalized name already
--     belongs to a DIFFERENT member, we refuse to create a second user and ask a human.
--     Living in the RPC (not TypeScript) is what makes dry-run/apply parity STRUCTURAL —
--     one function answers both.
--
--     The response deliberately REUSES status='phone_name_conflict' and adds a
--     `conflict_kind` discriminant. An old client sees only the status it already knows,
--     pushes a conflict and skips the member: fail closed, nothing written, and — critically
--     — NOT counted as "updated". A new client reads conflict_kind and renders the richer
--     copy. This is what makes old-app-plus-new-DB genuinely safe rather than merely tolerable.
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
  v_user_id           uuid;
  v_existing_name     text;
  v_status            text;
  v_plate             text;
  v_norm              text;
  v_owner             uuid;
  v_vehicles_added    int := 0;
  v_plate_conflicts   text[] := '{}';
  v_dep               jsonb;
  v_deps_added        int := 0;
  v_primary_name      text;
  v_primary_bd        date;
  v_child_bd          date;
  v_retained_p2       boolean := false;
  v_retained_revoked  boolean := false;
  v_retained_governed boolean := false;
  v_frozen            boolean := false;
  v_key               text;
  v_norm_plates       text[] := '{}';
  v_candidates        jsonb;
begin
  select id, display_name into v_user_id, v_existing_name from users where phone_number = p_phone;
  if found then
    if v_existing_name is distinct from p_name then
      return jsonb_build_object(
        'status', 'phone_name_conflict',
        'conflict_kind', 'phone_name_mismatch',
        'existing_name', v_existing_name);
    end if;
    v_status := 'updated';
  else
    -- Serialize check-then-insert on the name key: two concurrent imports of the same new
    -- name would otherwise both see "no candidates" and both insert. The key is NOT unique
    -- (by design), so no index can catch this.
    v_key := normalize_member_name_for_match(p_name);
    perform pg_advisory_xact_lock(hashtext('member_name_match:' || v_key));

    -- Evidence is per candidate and looks ONLY at currently-active vehicles. An inactive
    -- historical row must not raise the evidence: after a plate changes hands, "A once had
    -- this plate, B has it now" would otherwise read as "probably the same person".
    if p_plates is not null then
      select coalesce(array_agg(n), '{}') into v_norm_plates
        from (
          select upper(regexp_replace(p, '[^A-Za-z0-9]', '', 'g')) as n
            from unnest(p_plates) as t(p)
        ) s
       where n <> '';
    end if;

    select jsonb_agg(jsonb_build_object(
             'id', c.id,
             'phone', c.phone_number,
             'evidence', case when c.plate_match then 'same_name_and_plate' else 'same_name' end)
             order by c.display_name, c.id)
      into v_candidates
      from (
        select u.id, u.phone_number, u.display_name,
               exists (
                 select 1 from vehicles v
                  where v.user_id = u.id and v.is_active
                    and v.license_plate_normalized = any (v_norm_plates)
               ) as plate_match
          from users u
         where u.member_name_match_key = v_key
      ) c;

    if v_candidates is not null then
      return jsonb_build_object(
        'status', 'phone_name_conflict',
        'conflict_kind', 'identity_candidate',
        'candidates', v_candidates);
    end if;

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
      select user_id into v_owner from vehicles
       where license_plate_normalized = v_norm and is_active;
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
    -- ── P2 path — eligibility summary: primary dependent = first in the list ──
    if p_dependents is not null and jsonb_array_length(p_dependents) > 0 then
      v_primary_name := p_dependents->0->>'name';
      v_primary_bd   := nullif(p_dependents->0->>'birthdate', '')::date;
    end if;

    -- The YOUNGEST child, which is a different question from "the first dependent".
    if p_reason = 'child_companion' and p_dependents is not null then
      select max(nullif(value->>'birthdate', '')::date) into v_child_bd
        from jsonb_array_elements(p_dependents) as t(value)
       where value->>'kind' = 'child';
    end if;

    -- Precedence. Both are READS, so dry-run and apply answer identically.
    if v_user_id is not null then
      select (review_status = 'revoked'), (reviewed_at is not null)
        into v_retained_revoked, v_retained_governed
        from user_eligibility where user_id = v_user_id;
      v_retained_revoked  := coalesce(v_retained_revoked, false);
      v_retained_governed := coalesce(v_retained_governed, false);
      -- A revoked row is always governed; report only the more specific one.
      if v_retained_revoked then
        v_retained_governed := false;
      end if;
      v_frozen := v_retained_revoked or v_retained_governed;
    end if;

    if not p_dry_run and v_user_id is not null and not v_frozen then
      insert into user_eligibility (
        user_id, review_status, p2_reason, p2_valid_until, p2_review_date,
        p2_child_birthdate, dependent_name, dependent_birthdate)
      values (
        v_user_id, 'approved', p_reason, p_valid_until, p_review_date,
        v_child_bd, v_primary_name, v_primary_bd)
      on conflict (user_id) do update set
        review_status       = 'approved',
        p2_reason           = excluded.p2_reason,
        p2_valid_until      = excluded.p2_valid_until,
        p2_review_date      = excluded.p2_review_date,
        p2_child_birthdate  = excluded.p2_child_birthdate,
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
    elsif p_dependents is not null and not v_frozen then
      -- Dry-run projection. `not v_frozen` is what keeps dry-run == apply: a frozen member's
      -- dependents are not written on apply, so the preview must not promise they would be.
      v_deps_added := jsonb_array_length(p_dependents);
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
    'status',            v_status,
    'vehicles_added',    v_vehicles_added,
    'dependents_added',  v_deps_added,
    'plate_conflicts',   to_jsonb(v_plate_conflicts),
    'retained_p2',       v_retained_p2,
    'retained_revoked',  v_retained_revoked,
    'retained_governed', v_retained_governed
  );
end $$;

revoke all on function import_member(text, text, text[], p2_reason, date, date, jsonb, boolean) from public;
grant execute on function import_member(text, text, text[], p2_reason, date, date, jsonb, boolean) to service_role;

-- ════════════════════════════════════════════════════════════════════════════════
-- (6) apply_reservation — lock the vehicle row while checking it is active
-- ════════════════════════════════════════════════════════════════════════════════
-- The composite FK guarantees ownership but says NOTHING about is_active, and the old check
-- read the row without a lock. Once deactivation exists, that is a live race:
--
--     member apply                       admin deactivate
--     SELECT vehicle → active ✓
--                                        lock vehicle / no unfinished reservations / set inactive / commit
--     INSERT reservation → succeeds      ⇒ inactive vehicle WITH a fresh pending reservation
--
-- `FOR SHARE` closes it from this side; set_member_vehicle_active takes FOR UPDATE on the same
-- row from the other. Whichever commits first, the loser re-reads and refuses.
--
-- Lock order (no cycle): apply_reservation = weekly_events → vehicles;
-- set_member_vehicle_active = vehicles only, and never touches weekly_events.
--
-- Only the vehicle check changed; every guard, message and the signature are as in 0023.
create or replace function apply_reservation(
  p_event_id           uuid,
  p_user_id            uuid,
  p_vehicle_id         uuid,
  p_requested_p2       boolean,
  p_effective_priority smallint,
  p_now                timestamptz
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_id     uuid;
begin
  -- Lock the event row: serializes this window check against claim_friday_allocation.
  select status into v_status from weekly_events where id = p_event_id for update;
  if not found or v_status <> 'open' then
    return jsonb_build_object('applied', 0, 'reason', 'event_not_open');
  end if;

  perform 1 from job_runs
    where weekly_event_id = p_event_id
      and job_type = 'friday_allocation'
      and status in ('running', 'success');
  if found then
    return jsonb_build_object('applied', 0, 'reason', 'applications_closed');
  end if;

  -- The vehicle must belong to the applicant and still be active. FOR SHARE holds that
  -- answer for the rest of this transaction (see the header).
  perform 1 from vehicles
    where id = p_vehicle_id and user_id = p_user_id and is_active
    for share;
  if not found then
    return jsonb_build_object('applied', 0, 'reason', 'vehicle_not_owned');
  end if;

  -- One active reservation per member per week: the partial unique index
  -- reservations_one_active_per_member is the authoritative guard (cancelled rows
  -- excluded, so a member may re-apply after cancelling).
  begin
    insert into reservations
      (weekly_event_id, user_id, vehicle_id, requested_p2_this_week, effective_priority,
       status, applied_at)
    values
      (p_event_id, p_user_id, p_vehicle_id, p_requested_p2, p_effective_priority,
       'pending', p_now)
    returning id into v_id;
  exception when unique_violation then
    return jsonb_build_object('applied', 0, 'reason', 'already_applied');
  end;

  return jsonb_build_object('applied', 1, 'reason', 'applied', 'reservation_id', v_id);
end $$;

revoke all on function apply_reservation(uuid, uuid, uuid, boolean, smallint, timestamptz) from public;
grant execute on function apply_reservation(uuid, uuid, uuid, boolean, smallint, timestamptz) to service_role;

-- ════════════════════════════════════════════════════════════════════════════════
-- (7) capture_liff_binding_claim — resolve and freeze the member at capture
-- ════════════════════════════════════════════════════════════════════════════════
-- The member-facing response is UNCHANGED ({captured, superseded}). That matters: the LIFF
-- flow deliberately has no membership oracle — a caller must not be able to learn whether a
-- phone is registered. The DB now knows the answer and the admin sees it later; the LINE
-- caller still learns nothing.
--
-- Takes the shared binding-identity advisory lock (see update_member_identity) so a capture
-- cannot interleave with a phone change and snapshot a member who is mid-rename.
create or replace function capture_liff_binding_claim(
  p_line_user_id text,
  p_phone        text,
  p_name         text,
  p_now          timestamptz
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_was_update boolean;
  v_user_id    uuid;
begin
  perform pg_advisory_xact_lock(hashtext('member_identity_binding'));

  select id into v_user_id from users where phone_number = p_phone;

  insert into pending_binding
    (line_user_id, submitted_code, claim_source, claimed_phone, claimed_name,
     matched_user_id_at_capture, status, last_event_type, created_at, last_submitted_at)
  values
    (p_line_user_id, null, 'liff', p_phone, btrim(p_name),
     v_user_id, 'pending', 'liff', p_now, p_now)
  on conflict (line_user_id) where status = 'pending'
  do update set
    claim_source               = 'liff',
    submitted_code             = null,                 -- XOR: switching from a keyword claim drops the code
    claimed_phone              = excluded.claimed_phone,
    claimed_name               = excluded.claimed_name,
    matched_user_id_at_capture = excluded.matched_user_id_at_capture,
    last_event_type            = 'liff',
    last_submitted_at          = p_now,
    superseded_count           = pending_binding.superseded_count + 1
  returning (xmax <> 0) into v_was_update;

  return jsonb_build_object('captured', 1, 'superseded', coalesce(v_was_update, false));
end $$;

revoke all on function capture_liff_binding_claim(text, text, text, timestamptz) from public;
grant execute on function capture_liff_binding_claim(text, text, text, timestamptz) to service_role;

-- ════════════════════════════════════════════════════════════════════════════════
-- (8) capture_pending_binding — the keyword branch must CLEAR the snapshot
-- ════════════════════════════════════════════════════════════════════════════════
-- 0022 established the XOR: the liff branch drops submitted_code, the keyword branch drops
-- claimed_phone/claimed_name. The snapshot belongs to the liff side, so superseding a liff
-- claim with a keyword one must clear it too — otherwise a keyword row keeps a stale liff
-- snapshot, which the shape constraint above now (correctly) rejects.
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
  insert into pending_binding
    (line_user_id, submitted_code, claim_source, claimed_phone, claimed_name,
     matched_user_id_at_capture, status, last_event_type, created_at, last_submitted_at)
  values
    (p_line_user_id, p_code, 'keyword', null, null,
     null, 'pending', p_event_type, p_now, p_now)
  on conflict (line_user_id) where status = 'pending'
  do update set
    claim_source               = 'keyword',
    submitted_code             = excluded.submitted_code,
    claimed_phone              = null,                 -- XOR: switching from a liff claim drops phone/name
    claimed_name               = null,
    matched_user_id_at_capture = null,                 -- …and the identity snapshot that went with them
    last_event_type            = excluded.last_event_type,
    last_submitted_at          = p_now,
    superseded_count           = pending_binding.superseded_count + 1
  returning (xmax <> 0) into v_was_update;

  return jsonb_build_object('captured', 1, 'superseded', coalesce(v_was_update, false));
end $$;

revoke all on function capture_pending_binding(text, text, text, timestamptz) from public;
grant execute on function capture_pending_binding(text, text, text, timestamptz) to service_role;

-- ════════════════════════════════════════════════════════════════════════════════
-- (9) approve_pending_binding — LIFF branch reads the snapshot, never the phone
-- ════════════════════════════════════════════════════════════════════════════════
-- Guard precedence is unchanged except that the liff branch's 'phone_not_found' becomes
-- 'unmatched_at_capture', which says something different and truer: not "this phone has no
-- member NOW" but "this claim matched nobody WHEN IT WAS SUBMITTED". The recovery is for the
-- member to submit again — capture is an upsert, so a re-send simply takes a fresh snapshot.
--
-- Also takes the shared binding-identity lock BEFORE the pending row lock. Without it this
-- function (pending_binding → users) and update_member_identity (users → pending_binding)
-- form a textbook lock inversion; the realistic trigger is one clerk changing a phone while
-- another approves that member's binding.
create or replace function approve_pending_binding(
  p_pending_id                uuid,
  p_expected_superseded_count bigint,
  p_now                       timestamptz,
  p_dry_run                   boolean,
  p_admin_id                  uuid default null
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_pending  pending_binding%rowtype;
  v_code     binding_codes%rowtype;
  v_user_id  uuid;
  v_existing text;
  v_updated  int;
begin
  perform pg_advisory_xact_lock(hashtext('member_identity_binding'));

  select * into v_pending from pending_binding where id = p_pending_id for update;
  if not found then
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'pending_not_found');
  end if;

  if v_pending.status <> 'pending' then
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'pending_not_pending');
  end if;

  -- Optimistic concurrency: an apply must approve exactly the revision the admin previewed.
  if not p_dry_run then
    if p_expected_superseded_count is null
       or v_pending.superseded_count <> p_expected_superseded_count then
      return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'pending_changed');
    end if;
  end if;

  if v_pending.claim_source = 'keyword' then
    select * into v_code from binding_codes where code = v_pending.submitted_code;
    if not found then
      return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'code_not_found');
    end if;
    if v_code.expires_at < p_now then
      return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'code_expired');
    end if;
    if v_code.consumed_at is not null then
      return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'code_consumed');
    end if;
    v_user_id := v_code.user_id;
  else
    -- liff claim: the member was resolved AT CAPTURE. Never re-resolve claimed_phone here —
    -- that is exactly the cross-identity binding this slice exists to remove.
    v_user_id := v_pending.matched_user_id_at_capture;
    if v_user_id is null then
      return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'unmatched_at_capture');
    end if;
  end if;

  select line_id into v_existing from users where id = v_user_id;
  if not found then
    -- The snapshot points at a member who no longer exists. No delete path exists today, so
    -- this is a "cannot happen" that fails closed rather than binding to nobody.
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'unmatched_at_capture');
  end if;
  if v_existing is not null then
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'member_already_bound');
  end if;

  -- Is this LINE account already bound to a (necessarily different) member?
  perform 1 from users where line_id = v_pending.line_user_id;
  if found then
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'line_id_taken');
  end if;

  if p_dry_run then
    return jsonb_build_object('approved', 0, 'would_approve', true, 'reason', 'approved');
  end if;

  -- Commit. The users write is guarded on `line_id is null`; a concurrent bind of the same
  -- line_user_id to another member surfaces as line_id_taken via the unique index, not a 500.
  begin
    update users set line_id = v_pending.line_user_id
     where id = v_user_id and line_id is null;
    get diagnostics v_updated = row_count;
  exception when unique_violation then
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'line_id_taken');
  end;
  if v_updated = 0 then
    -- Raced: member got bound between the guard and this write.
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'member_already_bound');
  end if;

  if v_pending.claim_source = 'keyword' then
    update binding_codes set
      consumed_at                 = p_now,
      consumed_pending_binding_id = v_pending.id,
      consumed_line_user_id       = v_pending.line_user_id
     where id = v_code.id;
  end if;

  -- Only this committed path records the decider — dry-runs and every guarded
  -- rejection above write nothing.
  update pending_binding set
    status              = 'approved',
    approved_at         = p_now,
    approved_user_id    = v_user_id,
    decided_by_admin_id = p_admin_id
   where id = v_pending.id;

  return jsonb_build_object('approved', 1, 'would_approve', true, 'reason', 'approved');
end $$;

revoke all on function approve_pending_binding(uuid, bigint, timestamptz, boolean, uuid) from public;
grant execute on function approve_pending_binding(uuid, bigint, timestamptz, boolean, uuid) to service_role;

-- ════════════════════════════════════════════════════════════════════════════════
-- (10) The four new admin maintenance mutations
-- ════════════════════════════════════════════════════════════════════════════════
-- Rules inherited from 0035/0036 and NOT re-derived here:
--   * Acting-account template: read role AND disabled_at (neither in the WHERE, or "no such
--     account" and "account disabled" collapse into one not-found and the disabled actor's
--     role is unreadable), FOR SHARE. acting_admin_not_found → NO audit (no account = no role,
--     and it is a bad request); acting_admin_disabled → audited 'denied'.
--   * The role is read HERE, never asserted by the caller, and the value used to authorise is
--     the SAME value handed to the audit writer.
--   * Governance refusals are TYPED RETURNS, never raises — a raise would roll back the very
--     row that records the refusal.
--
-- Capability: these are day-to-day clerk work (a clerk can already bulk-import members and
-- see full PII), so both tiers may call them. There is deliberately no new capability — see
-- lib/adminRoles.ts on why "what everyone can do" gets no entry.
--
-- Audit result classification, decided once so four functions cannot each invent one:
--   invalid_name / invalid_phone / invalid_plate / *_not_found  → no audit (bad request)
--   no_change / already_active / already_inactive               → no audit (inert)
--   homonym_requires_confirmation                               → no audit (step one of a
--                                                                  flow, not a refusal;
--                                                                  auditing every preview
--                                                                  would flood the log)
--   inactive_plate_exists                                       → no audit (guidance)
--   homonym_confirmation_stale                                  → conflict
--   phone_in_use                                                → denied (an identity
--                                                                  uniqueness guard refused;
--                                                                  NOT an optimistic-lock
--                                                                  race, even when the unique
--                                                                  index is what surfaced it —
--                                                                  DB timing is not domain
--                                                                  semantics)
--   unfinished_reservations / active_plate_owned_by_*           → denied
--   success                                                     → success
--
-- Unique indexes are the LAST authority in all four: a check-then-write that only SELECTs
-- first is not a guard. Every write catches unique_violation, re-reads, and returns a typed
-- reason. A 23505 must never reach a caller.

-- ── create_member ────────────────────────────────────────────────────────────────
-- The homonym confirmation is a candidate-SET decision, not a single-candidate one: the name
-- key is legitimately non-unique, so "I confirm this is not A" does not mean "…and not B".
-- The confirmed set is compared as a SET (order carries no meaning and the query has no
-- ORDER BY guarantee to lean on); duplicates in the input do not change its meaning.
--
-- Evidence is always 'same_name' here — this form has no vehicle input, so there is no
-- incoming plate to compare. 'same_name_and_plate' can only arise from a CSV import.
create function create_member(
  p_display_name            text,
  p_phone                   text,
  p_acting_admin_id         uuid,
  p_acting_session_id       uuid,
  p_request_id              uuid,
  p_confirmed_candidate_ids uuid[] default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acting_role        admin_role;
  v_acting_disabled_at timestamptz;
  v_action             text := 'member.create';
  v_name               text;
  v_key                text;
  v_actual             uuid[];
  v_confirmed          uuid[];
  v_candidates         jsonb;
  v_user_id            uuid;
begin
  select role, disabled_at into v_acting_role, v_acting_disabled_at
    from admin_accounts where id = p_acting_admin_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_not_found');
  end if;
  if v_acting_disabled_at is not null then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'member', null, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'acting_admin_disabled'));
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_disabled');
  end if;

  v_name := btrim(coalesce(p_display_name, ''));
  -- Minimum viable guard only. display_name is NOT NULL but the empty string passes that,
  -- and an empty name key would pollute the candidate mechanism. No format or length rules
  -- beyond this — that would be scope creep.
  if v_name = '' or normalize_member_name_for_match(v_name) = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_name');
  end if;
  if p_phone is null or p_phone !~ '^09[0-9]{8}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_phone');
  end if;

  v_key := normalize_member_name_for_match(v_name);
  perform pg_advisory_xact_lock(hashtext('member_name_match:' || v_key));

  select coalesce(array_agg(id order by id), '{}') into v_actual
    from users where member_name_match_key = v_key;

  if array_length(v_actual, 1) is not null then
    -- Deduplicate + sort BOTH sides so the comparison is set equality.
    select coalesce(array_agg(distinct x order by x), '{}') into v_confirmed
      from unnest(coalesce(p_confirmed_candidate_ids, '{}'::uuid[])) as t(x);

    if p_confirmed_candidate_ids is null then
      select jsonb_agg(jsonb_build_object(
               'id', u.id, 'phone', u.phone_number, 'evidence', 'same_name')
               order by u.display_name, u.id)
        into v_candidates
        from users u where u.member_name_match_key = v_key;
      return jsonb_build_object(
        'ok', false, 'reason', 'homonym_requires_confirmation', 'candidates', v_candidates);
    end if;

    if v_actual <> v_confirmed then
      select jsonb_agg(jsonb_build_object(
               'id', u.id, 'phone', u.phone_number, 'evidence', 'same_name')
               order by u.display_name, u.id)
        into v_candidates
        from users u where u.member_name_match_key = v_key;
      perform private.append_audit_log(
        'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
        v_action, 'member', null, null,
        p_request_id, 'conflict', jsonb_build_object('reason', 'homonym_confirmation_stale'));
      return jsonb_build_object(
        'ok', false, 'reason', 'homonym_confirmation_stale', 'candidates', v_candidates);
    end if;
  end if;

  begin
    insert into users (display_name, phone_number) values (v_name, p_phone) returning id into v_user_id;
  exception when unique_violation then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'member', null, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'phone_in_use'));
    return jsonb_build_object('ok', false, 'reason', 'phone_in_use');
  end;

  perform private.append_audit_log(
    'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
    v_action, 'member', v_user_id, null,
    p_request_id, 'success',
    jsonb_build_object(
      'homonym_confirmed', array_length(v_actual, 1) is not null,
      'candidate_count', coalesce(array_length(v_actual, 1), 0)));

  return jsonb_build_object('ok', true, 'user_id', v_user_id);
end $$;

revoke all on function create_member(text, text, uuid, uuid, uuid, uuid[]) from public;
grant execute on function create_member(text, text, uuid, uuid, uuid, uuid[]) to service_role;

-- ── update_member_identity ───────────────────────────────────────────────────────
-- Target is ALWAYS users.id. Nothing here looks a member up by their old phone.
--
-- A rename does not need homonym confirmation — it mutates an existing UUID rather than
-- creating an identity. But it DOES move that member into another name candidate set, so it
-- must serialize on the NEW key: otherwise create_member can confirm a set of [A,B], have C
-- renamed into that set, and insert a member the operator never got to consider.
--
-- Only the NEW key is locked, deliberately. LEAVING a key ("王小明"→"王大明") racing a
-- create of 王小明 can only cause one extra confirmation of a member who has since been
-- renamed — fail-closed, and it cannot hide a new candidate.
--
-- Lock order: binding-identity lock first (shared with capture/approve), then the name key.
-- No other function takes both, so no cycle exists.
create function update_member_identity(
  p_user_id           uuid,
  p_display_name      text,
  p_phone             text,
  p_acting_admin_id   uuid,
  p_acting_session_id uuid,
  p_request_id        uuid,
  p_now               timestamptz
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acting_role        admin_role;
  v_acting_disabled_at timestamptz;
  v_action             text := 'member.identity_change';
  v_name               text;
  v_old_name           text;
  v_old_phone          text;
  v_name_changed       boolean;
  v_phone_changed      boolean;
  v_invalidated        int := 0;
begin
  select role, disabled_at into v_acting_role, v_acting_disabled_at
    from admin_accounts where id = p_acting_admin_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_not_found');
  end if;
  if v_acting_disabled_at is not null then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'member', p_user_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'acting_admin_disabled'));
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_disabled');
  end if;

  v_name := btrim(coalesce(p_display_name, ''));
  if v_name = '' or normalize_member_name_for_match(v_name) = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_name');
  end if;
  if p_phone is null or p_phone !~ '^09[0-9]{8}$' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_phone');
  end if;

  perform pg_advisory_xact_lock(hashtext('member_identity_binding'));
  perform pg_advisory_xact_lock(hashtext('member_name_match:' || normalize_member_name_for_match(v_name)));

  select display_name, phone_number into v_old_name, v_old_phone
    from users where id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  v_name_changed  := v_old_name is distinct from v_name;
  v_phone_changed := v_old_phone is distinct from p_phone;
  if not v_name_changed and not v_phone_changed then
    return jsonb_build_object('ok', true, 'changed', false);
  end if;

  begin
    update users set display_name = v_name, phone_number = p_phone where id = p_user_id;
  exception when unique_violation then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'member', p_user_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'phone_in_use'));
    return jsonb_build_object('ok', false, 'reason', 'phone_in_use');
  end;

  -- A phone change invalidates this member's OUTSTANDING liff claims. The join key is the
  -- SNAPSHOT, not the phone: the snapshot is what approval will act on.
  -- All three decision columns are written. rejected_at is not optional — the retention scan
  -- keys on coalesce(approved_at, rejected_at), and NULL <= cutoff is NULL, so a row rejected
  -- without it would never be swept and its claim PII would live forever.
  if v_phone_changed then
    update pending_binding set
      status              = 'rejected',
      rejected_at         = p_now,
      rejected_reason     = 'phone_changed_by_admin',
      decided_by_admin_id = p_acting_admin_id
     where status = 'pending'
       and claim_source = 'liff'
       and matched_user_id_at_capture = p_user_id;
    get diagnostics v_invalidated = row_count;
  end if;

  perform private.append_audit_log(
    'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
    v_action, 'member', p_user_id, null,
    p_request_id, 'success',
    jsonb_build_object(
      'name_changed', v_name_changed,
      'phone_changed', v_phone_changed,
      'bindings_invalidated', v_invalidated));

  return jsonb_build_object(
    'ok', true, 'changed', true, 'bindings_invalidated', v_invalidated);
end $$;

revoke all on function update_member_identity(uuid, text, text, uuid, uuid, uuid, timestamptz) from public;
grant execute on function update_member_identity(uuid, text, text, uuid, uuid, uuid, timestamptz) to service_role;

-- ── add_member_vehicle ───────────────────────────────────────────────────────────
-- Four distinct situations, four distinct answers. In particular an INACTIVE row owned by
-- the same member is NOT a reason to create a second row: reactivate exists precisely for
-- that, and stacking rows would make the history meaningless.
create function add_member_vehicle(
  p_user_id           uuid,
  p_license_plate     text,
  p_acting_admin_id   uuid,
  p_acting_session_id uuid,
  p_request_id        uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acting_role        admin_role;
  v_acting_disabled_at timestamptz;
  v_action             text := 'vehicle.add';
  v_plate              text;
  v_norm               text;
  v_active_owner       uuid;
  v_inactive_id        uuid;
  v_vehicle_id         uuid;
begin
  select role, disabled_at into v_acting_role, v_acting_disabled_at
    from admin_accounts where id = p_acting_admin_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_not_found');
  end if;
  if v_acting_disabled_at is not null then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'vehicle', null, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'acting_admin_disabled'));
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_disabled');
  end if;

  v_plate := btrim(coalesce(p_license_plate, ''));
  v_norm  := upper(regexp_replace(v_plate, '[^A-Za-z0-9]', '', 'g'));
  if v_norm = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_plate');
  end if;

  perform 1 from users where id = p_user_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'member_not_found');
  end if;

  select user_id into v_active_owner from vehicles
   where license_plate_normalized = v_norm and is_active;
  if found then
    if v_active_owner = p_user_id then
      return jsonb_build_object('ok', false, 'reason', 'active_plate_owned_by_self');
    end if;
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'vehicle', null, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'active_plate_owned_by_other'));
    return jsonb_build_object('ok', false, 'reason', 'active_plate_owned_by_other');
  end if;

  -- No active holder. If THIS member already has it in history, point at reactivate rather
  -- than growing a second row; another member's history is no obstacle to a genuine handover.
  select id into v_inactive_id from vehicles
   where license_plate_normalized = v_norm and user_id = p_user_id and not is_active
   order by created_at desc limit 1;
  if found then
    return jsonb_build_object(
      'ok', false, 'reason', 'inactive_plate_exists', 'vehicle_id', v_inactive_id);
  end if;

  begin
    insert into vehicles (user_id, license_plate) values (p_user_id, v_plate)
    returning id into v_vehicle_id;
  exception when unique_violation then
    -- Lost a race against another add/reactivate. Re-read rather than guess who won.
    select user_id into v_active_owner from vehicles
     where license_plate_normalized = v_norm and is_active;
    if v_active_owner = p_user_id then
      return jsonb_build_object('ok', false, 'reason', 'active_plate_owned_by_self');
    end if;
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'vehicle', null, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'active_plate_owned_by_other'));
    return jsonb_build_object('ok', false, 'reason', 'active_plate_owned_by_other');
  end;

  perform private.append_audit_log(
    'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
    v_action, 'vehicle', v_vehicle_id, null,
    p_request_id, 'success', '{}'::jsonb);

  return jsonb_build_object('ok', true, 'vehicle_id', v_vehicle_id);
end $$;

revoke all on function add_member_vehicle(uuid, text, uuid, uuid, uuid) from public;
grant execute on function add_member_vehicle(uuid, text, uuid, uuid, uuid) to service_role;

-- ── set_member_vehicle_active ────────────────────────────────────────────────────
-- Deactivation is refused while ANY unfinished reservation references the vehicle, and that
-- is checked in-transaction under the vehicle's row lock — a disabled button is not a guard.
-- The concrete failure it prevents: a car approved on Friday, deactivated on Saturday, and a
-- Sunday check-in list that disagrees with the member's own screen.
--
-- "Unfinished" = a NON-TERMINAL reservation status, mirroring lib/allocation/transitions.ts:
-- pending / approved / temp_approved / waiting / released_late. released_late belongs here —
-- it can still become attended_after_release or no_show. walk_in cannot appear: 0002's CHECK
-- forces walk_in rows to have a NULL vehicle_id.
create function set_member_vehicle_active(
  p_vehicle_id        uuid,
  p_is_active         boolean,
  p_acting_admin_id   uuid,
  p_acting_session_id uuid,
  p_request_id        uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acting_role        admin_role;
  v_acting_disabled_at timestamptz;
  v_action             text;
  v_owner              uuid;
  v_norm               text;
  v_is_active          boolean;
  v_active_owner       uuid;
  v_unfinished         int;
begin
  v_action := case when p_is_active then 'vehicle.reactivate' else 'vehicle.deactivate' end;

  select role, disabled_at into v_acting_role, v_acting_disabled_at
    from admin_accounts where id = p_acting_admin_id for share;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_not_found');
  end if;
  if v_acting_disabled_at is not null then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'vehicle', p_vehicle_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'acting_admin_disabled'));
    return jsonb_build_object('ok', false, 'reason', 'acting_admin_disabled');
  end if;

  select user_id, license_plate_normalized, is_active
    into v_owner, v_norm, v_is_active
    from vehicles where id = p_vehicle_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'vehicle_not_found');
  end if;

  if v_is_active = p_is_active then
    return jsonb_build_object(
      'ok', false,
      'reason', case when p_is_active then 'already_active' else 'already_inactive' end);
  end if;

  if not p_is_active then
    select count(*) into v_unfinished from reservations
     where vehicle_id = p_vehicle_id
       and status in ('pending', 'approved', 'temp_approved', 'waiting', 'released_late');
    if v_unfinished > 0 then
      perform private.append_audit_log(
        'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
        v_action, 'vehicle', p_vehicle_id, null,
        p_request_id, 'denied', jsonb_build_object('reason', 'unfinished_reservations'));
      return jsonb_build_object(
        'ok', false, 'reason', 'unfinished_reservations', 'unfinished', v_unfinished);
    end if;
  end if;

  begin
    update vehicles set is_active = p_is_active where id = p_vehicle_id;
  exception when unique_violation then
    -- Reactivating a plate somebody else now holds. Re-read the CURRENT active owner and
    -- classify from that: the owner may well be this same member (two historical rows), and
    -- calling every collision "owned by other" would be a lie.
    select user_id into v_active_owner from vehicles
     where license_plate_normalized = v_norm and is_active;
    if v_active_owner = v_owner then
      return jsonb_build_object('ok', false, 'reason', 'active_plate_owned_by_self');
    end if;
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
      v_action, 'vehicle', p_vehicle_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'active_plate_owned_by_other'));
    return jsonb_build_object('ok', false, 'reason', 'active_plate_owned_by_other');
  end;

  perform private.append_audit_log(
    'admin', p_acting_admin_id, p_acting_session_id, v_acting_role::text,
    v_action, 'vehicle', p_vehicle_id, null,
    p_request_id, 'success', '{}'::jsonb);

  return jsonb_build_object('ok', true, 'vehicle_id', p_vehicle_id, 'is_active', p_is_active);
end $$;

revoke all on function set_member_vehicle_active(uuid, boolean, uuid, uuid, uuid) from public;
grant execute on function set_member_vehicle_active(uuid, boolean, uuid, uuid, uuid) to service_role;
