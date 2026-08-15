-- Wave 2B-2a (#10): make P2 eligibility a reviewable model instead of a bare boolean
-- that only a CSV import can write, and fix the child-companion expiry rule.
--
-- This is the MODEL half of #10. It ships NO UI and NO write RPC — 2B-2b adds
-- set_p2_eligibility / mark_p2_reviewed on top of what this establishes.
--
-- ── DEPLOY: DB FIRST, then app. There IS an ordering constraint ─────────────────
-- import_member keeps its exact signature (create or replace, body only), so this is
-- NOT a 0030-style signature break. But that alone proves nothing about the app:
--   old app + new DB : compatible — p2_eligible is still readable (now generated),
--                      import_member's signature is unchanged, and the new
--                      retained_revoked jsonb key is simply ignored by the old caller.
--   new app + old DB : NOT compatible — the app selects review_status /
--                      review_version / p2_valid_from / p2_child_birthdate.
--   rollback         : redeploy the OLD APP against the new DB. Reverting this
--                      migration is not the normal recovery path — it would drop two
--                      audited markers and re-materialise p2_eligible as a plain column.
--
-- ── 避免雙重真相: review_status is authoritative, p2_eligible is derived ─────────
-- The triage contract for #10. The critical detail is WHAT p2_eligible derives from:
-- `review_status = 'approved'` and NOTHING ELSE. No date term.
--
-- Why that matters. Two readers ask two DIFFERENT questions with two DIFFERENT
-- correct as-of dates:
--   lib/allocation/priority.ts    "is this member P2 for the event on Sunday D?"
--                                 -> as-of = the event's sunday_date
--   lib/eligibilityStatus.ts      "does this eligibility need a human TODAY?"
--                                 -> as-of = Taipei today
-- If p2_eligible meant "valid now", it would bake in whichever as-of date the WRITER
-- happened to use, and both readers would silently inherit it. Concretely: approve on
-- Wed 06-17 with valid_from = Sat 06-20, and a write-time-derived p2_eligible is false
-- -> a member applying Wed for Sunday 06-21 is dropped to P3, even though they ARE
-- eligible that Sunday. Nothing throws; the member just quietly loses their place.
--
-- Keeping the date OUT of the column also means there is NO date arithmetic in SQL
-- here, so unlike 0031 this file does not duplicate a formula. (The one exception is
-- the child-cohort recompute below, which is a one-time statement, not a live path.)
--
-- The three-state enum is deliberate: 'revoked' must mean A HUMAN REVOKED THIS.
-- Backfilling every non-P2 row to 'revoked' would fabricate that, and the fabrication
-- would then be written into an append-only audit marker. 'unreviewed' is the neutral
-- state the migration needs; it is NOT #11's intake workflow (pending /
-- needs_information / rejected still belong there).
--
-- ── p2_eligible cannot be converted in place ────────────────────────────────────
-- Verified on PG 17.6: there is no `alter column ... set generated always as (...)`.
-- A plain column can only become generated via DROP + re-ADD, which is why this file
-- drops the dependent CHECK explicitly and rebuilds it. Deliberately NO
-- `drop column ... cascade` — cascade would silently delete DB contracts nobody
-- inventoried. The full inventory of things depending on this column (pg_depend /
-- pg_rewrite / pg_constraint / pg_policies / pg_trigger / pg_proc, 2026-07-17):
--   views, rewrite rules, RLS policies, triggers, indexes ... none
--   CHECK  ... eligibility_reason_present  (dropped and recreated below)
--   funcs  ... import_member ONLY          (rewritten below)

-- ── Pre-flight: fail loudly rather than corrupt ─────────────────────────────────
do $$
declare
  v_bad int;
begin
  -- reviewed_by is about to be repointed from users(id) to admin_accounts(id).
  -- It has never had a writer (0001 defined it; nothing has ever set it), so this is
  -- expected to be 0 — but prod must PROVE that rather than inherit the assumption,
  -- and unknown data must never be silently nulled to make a migration pass.
  select count(*) into v_bad from user_eligibility where reviewed_by is not null;
  if v_bad > 0 then
    raise exception 'reviewed_by holds % legacy users(id) value(s); manual reconciliation required before repointing the FK to admin_accounts', v_bad;
  end if;

  -- The generated column and the rebuilt CHECK both assume existing rows are sane.
  select count(*) into v_bad from user_eligibility where p2_eligible and p2_reason is null;
  if v_bad > 0 then
    raise exception '% eligibility row(s) are p2_eligible with no reason — eligibility_reason_present cannot be rebuilt', v_bad;
  end if;
end $$;

-- ── review_status: the new authority ────────────────────────────────────────────
create type p2_review_status as enum ('unreviewed', 'approved', 'revoked');

comment on type p2_review_status is
  'unreviewed = no human decision on record (the state legacy rows and future intake start in). '
  'approved = a 幹事 granted P2. revoked = a 幹事 explicitly took it away — never inferred, only written by a human decision. '
  '#11 adds pending / needs_information / rejected for real self-service intake.';

alter table user_eligibility add column review_status p2_review_status not null default 'unreviewed';

-- Backfill: true -> approved. false -> UNREVIEWED, never 'revoked' (see header).
-- In practice no false rows exist: import_member's P2 path always writes true and its
-- general path writes no row at all, so a general member has NO eligibility row rather
-- than a false one. Test fixtures do create false rows, and manual SQL could — which is
-- exactly why this must not mislabel data it merely believes cannot exist.
update user_eligibility
   set review_status = case when p2_eligible then 'approved'::p2_review_status
                                             else 'unreviewed'::p2_review_status end;

-- ── p2_eligible: plain column -> generated (DROP + re-ADD; see header) ──────────
alter table user_eligibility drop constraint eligibility_reason_present;
alter table user_eligibility drop column p2_eligible;

alter table user_eligibility
  add column p2_eligible boolean
  generated always as (review_status = 'approved') stored;

comment on column user_eligibility.p2_eligible is
  'DERIVED — do not write. review_status is the authority. Deliberately carries NO date term: '
  'it answers "is this approved?", never "is this valid today?". Callers must apply the date '
  'window themselves with an EXPLICIT as-of date (isWithinEligibilityWindow in '
  'lib/eligibilityStatus.ts) — the allocator uses the event Sunday, the review queue uses today. '
  'A future review_status value (e.g. #11 pending) is not-approved automatically: this expression '
  'IS the allowlist and fails closed.';

alter table user_eligibility
  add constraint eligibility_reason_present
  check (p2_eligible = false or p2_reason is not null);

-- ── reviewed_by: repoint to the table reviewers actually live in ───────────────
-- 0001 pointed this at users(id) — the MEMBER table — but a reviewing admin is an
-- admin_accounts.id, so the column could never have held its own reviewer. (It never
-- did: it has no writer, which is why 「最近覆核」 always renders as —.) #10 gives it
-- its first writer, so it has to point somewhere real.
--
-- An FK is safe here, unlike audit_logs.actor_id which deliberately has none: audit's
-- actor is polymorphic and must outlive rows that get deleted, whereas admin accounts
-- are soft-disabled and never hard-deleted (0026; 0030's actor-resolution relies on it).
alter table user_eligibility drop constraint user_eligibility_reviewed_by_fkey;
alter table user_eligibility
  add constraint user_eligibility_reviewed_by_fkey
  foreign key (reviewed_by) references admin_accounts(id);

-- ── The review window and its optimistic lock ──────────────────────────────────
alter table user_eligibility
  add column p2_valid_from      date,
  add column p2_child_birthdate date,
  add column review_note        text,
  add column review_version     int not null default 0;

comment on column user_eligibility.p2_valid_from is
  'Start of the eligibility window, INCLUSIVE (valid_from <= as-of <= valid_until). NULL = no start bound. '
  'Nothing writes this until 2B-2b, so it is NULL everywhere today and cannot change any allocation yet.';

comment on column user_eligibility.p2_child_birthdate is
  'MINOR-DEPENDENT PII. Must not appear in audit metadata, logs, analytics, list DTOs, or error '
  'messages. Session-gated eligibility detail / review surfaces only, and only where the exact date '
  'is genuinely needed; elsewhere report PRESENCE (a boolean), never the value. '
  'private.append_audit_log rejects it at the write boundary (see the sanitizer note in this file). '
  'Business meaning: for child_companion, the YOUNGEST child''s birthdate that p2_valid_until was '
  'derived from. Deliberately NOT dependent_birthdate — that column is the FIRST dependent in the '
  'CSV (0029:74), not necessarily the youngest, so it cannot serve as the derivation source.';

comment on column user_eligibility.review_version is
  'Optimistic lock for 2B-2b. Monotonic counter + caller-supplied expected value compared inside a '
  'FOR UPDATE-locked RPC — the repo idiom (approve_pending_binding 0022:118-155, set_weekly_capacity 0031). '
  'Deliberately not a timestamp: a counter cannot collide the way a caller-supplied timestamp can.';

-- Row-local, no date arithmetic. Only child_companion may carry a source birthdate.
-- Deliberately NOT the converse (child_companion => birthdate not null): a child_companion
-- with no birthdate on file is a real existing state (memberImport.ts:138 leaves
-- valid_until null and flags reviewRequired) and must stay representable.
alter table user_eligibility
  add constraint eligibility_child_birthdate_reason_ck
  check (p2_child_birthdate is null or p2_reason = 'child_companion');

alter table user_eligibility
  add constraint eligibility_window_ordered_ck
  check (p2_valid_from is null or p2_valid_until is null or p2_valid_from <= p2_valid_until);

-- ── Marker: the review_status backfill ─────────────────────────────────────────
do $$
declare
  v_rows       int;
  v_approved   int;
  v_unreviewed int;
begin
  select count(*) filter (where review_status = 'approved'),
         count(*) filter (where review_status = 'unreviewed'),
         count(*)
    into v_approved, v_unreviewed, v_rows
    from user_eligibility;

  -- NO revoked_count: the old boolean model cannot prove any row was human-revoked, so
  -- the marker must not imply one existed. (0031's lesson: a marker that counts anything
  -- other than what it claims writes a plausible, permanent lie into an append-only row.)
  perform private.append_audit_log(
    'system', null, null, null,
    'p2_eligibility.review_status_backfill', 'user_eligibility', null, null,
    gen_random_uuid(), 'success',
    jsonb_build_object(
      'rows_backfilled',  v_rows,
      'approved_count',   v_approved,
      'unreviewed_count', v_unreviewed,
      'derived_from',     'p2_eligible'));
end $$;

-- ── Child-companion expiry: Taiwan school-year cohort ──────────────────────────
-- OLD RULE (memberImport.ts:139): max(child birthdate) + 5 years, to the day. That is
-- not a cutoff rule at all — it expires a child mid-school-year on their birthday.
--
-- NEW RULE: eligibility runs until the day before the school year the child enters.
--   lastEligible(B) = August 31 of ( year(B) + 6 + (B on/after Sept 2 ? 1 : 0) )
-- 國民教育法: 當年 9/1 前滿 6 歲者入學 — so 9/1 INCLUSIVE is the earlier cohort and 9/2
-- starts the next one. Two children born a day apart across that line differ by a full
-- year, which is inherent to cohort rules, not a bug:
--   B = 2019-09-01 -> enters Sept 2025 -> 2025-08-31
--   B = 2019-09-02 -> enters Sept 2026 -> 2026-08-31
--
-- ⚠️ The cohort formula exists TWICE, like 0031's capacity formula, and for the same
-- kind of reason: the authority is TS (lib/eligibilityStatus.ts childCompanionValidUntil)
-- because the dry-run IMPORT PREVIEW must show the derived date before anything is
-- written, and SQL cannot serve a preview. This SQL copy is a ONE-TIME recompute frozen
-- in a migration, so it can never drift — but tests/integration/p2-review-model.db.test.ts
-- drives both from one shared fixture table and asserts they agree. That parity test is
-- the mitigation; if you change the rule, change both and keep it green.
do $$
declare
  v_rows      int;
  v_extended  int;
  v_shortened int;
begin
  -- Step 1: record the SOURCE for every child_companion who has a child on file. This is
  -- pure provenance — it changes no eligibility. The youngest child = MAX(birthdate);
  -- eligibility_dependents (0020) is the only trustworthy source, because
  -- user_eligibility.dependent_birthdate is dependents[0] (0029:74), not the youngest.
  with youngest as (
    select user_id, max(dependent_birthdate) as bd
      from eligibility_dependents
     where dependent_kind = 'child' and dependent_birthdate is not null
     group by user_id
  )
  update user_eligibility e
     set p2_child_birthdate = y.bd
    from youngest y
   where e.user_id = y.user_id
     and e.p2_reason = 'child_companion';

  -- Step 2: recompute ONLY rows the old rule actually dated (p2_valid_until is not null).
  --
  -- A child_companion with a NULL expiry is the review-required state (memberImport.ts:138
  -- writes it when no birthdate was on file). Deriving a date for those would silently
  -- auto-resolve a row that was deliberately flagged for a human, and — since NULL means
  -- "unbounded until someone decides" — would RESTRICT rather than extend it. Those rows
  -- stay in the queue where they belong. In practice the set is empty (an application
  -- import with children always dates the row), but a migration must not do the wrong
  -- thing to data it merely believes cannot exist.
  --
  -- The OLD value is captured BEFORE the update: counting "extended" afterwards would make
  -- it true by construction and turn the marker into a lie that reads as evidence — the
  -- exact bug 0031 caught in draft.
  with src as (
    select e.user_id,
           e.p2_valid_until as old_until,
           e.p2_review_date as old_review,
           make_date(
             extract(year from e.p2_child_birthdate)::int + 6
               + case when (extract(month from e.p2_child_birthdate)::int,
                            extract(day   from e.p2_child_birthdate)::int) > (9, 1) then 1 else 0 end,
             8, 31) as new_until
      from user_eligibility e
     where e.p2_reason = 'child_companion'
       and e.p2_child_birthdate is not null
       and e.p2_valid_until is not null
  ),
  upd as (
    update user_eligibility e
       set p2_valid_until = s.new_until,
           -- Import's convention is review_date == valid_until, but eligibilityStatus.ts:10-12
           -- warns that is a convention and NOT a constraint: a hand-corrected row may
           -- deliberately differ. Only move the review date where it was tracking the expiry.
           p2_review_date = case when e.p2_review_date = s.old_until then s.new_until
                                 else e.p2_review_date end
      from src s
     where e.user_id = s.user_id
    returning e.user_id
  )
  select (select count(*) from upd),
         count(*) filter (where new_until > old_until),
         count(*) filter (where new_until < old_until)
    into v_rows, v_extended, v_shortened
    from src;

  -- The new rule must only ever EXTEND: old = B+5y, new = Aug 31 of year(B)+6(+1), which
  -- is always later. Asserted here AND recorded as a number, so the claim is checkable
  -- from the audit row rather than taken on trust.
  if v_shortened > 0 then
    raise exception 'child expiry recompute SHORTENED % row(s); the cohort rule must only extend', v_shortened;
  end if;

  perform private.append_audit_log(
    'system', null, null, null,
    'p2_eligibility.child_expiry_recompute', 'user_eligibility', null, null,
    gen_random_uuid(), 'success',
    jsonb_build_object(
      'rows_recomputed', v_rows,
      'rows_extended',   v_extended,
      'rows_shortened',  v_shortened,
      'rule',            'tw_school_cohort_v1'));
end $$;

-- ── Close the audit sanitizer against birthdate-shaped keys ────────────────────
-- 0030's denylist is an EXACT key match, and it says so ("'job_name' or
-- 'review_note_present' are unaffected"). It carries 'birthdate' — which stops a key
-- literally named that, and nothing else. Verified against the live DB before writing
-- this: append_audit_log happily accepted
--     {"p2_child_birthdate_from":"2020-09-01","p2_child_birthdate_to":"2021-03-02"}
-- and returned a row id. audit_logs has UPDATE/DELETE/TRUNCATE revoked AND trigger-blocked,
-- so that row can never be corrected — a minor's date of birth, permanent, in a table
-- whose whole design is that nobody can take anything out of it.
--
-- Until this migration that was hypothetical: no column held a child's DOB. p2_child_birthdate
-- makes it a live risk, and 2B-2b adds the write RPC that would naturally name its metadata
-- after the column it changed. The boundary has to exist BEFORE the writer does.
--
-- The read-side registry (auditPresentation.ts) does NOT cover this. It stops an unknown key
-- being DISPLAYED; it cannot stop it being STORED. Display is recoverable — storage here is not.
--
-- The rule blocks VALUES, not vocabulary: a birthdate-shaped key may only ever hold a boolean.
-- That deliberately keeps `child_birthdate_present: true` legal — recording THAT a birthdate is
-- on file is exactly how a writer should answer the question without leaking the answer.
create or replace function private.append_audit_log(
  p_actor_type          audit_actor_type,
  p_actor_id            uuid,
  p_actor_session_id    uuid,
  p_actor_role_snapshot text,
  p_action              text,
  p_entity_type         text,
  p_entity_id           uuid,
  p_weekly_event_id     uuid,
  p_request_id          uuid,
  p_result              audit_result,
  p_metadata            jsonb
) returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id  uuid;
  v_key text;
  -- Never acceptable in an audit row, no matter which action is writing. Store the
  -- stable ID and resolve for display instead; record that a note EXISTS, never its
  -- text. (Exact key match — 'job_name' or 'review_note_present' are unaffected.)
  v_forbidden text[] := array[
    'phone', 'phone_number', 'mobile',
    'line_id', 'line_user_id', 'line_group_id',
    'token', 'session_token', 'binding_code',
    'password', 'password_hash', 'pin', 'pin_hash',
    'plate', 'license_plate',
    'name', 'display_name',
    'note', 'review_note', 'reason_text', 'remarks',
    'birthdate', 'address', 'email'
  ];
begin
  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'append_audit_log: metadata must be a JSON object';
  end if;

  if pg_column_size(p_metadata) > 2048 then
    raise exception 'append_audit_log: metadata too large (% bytes)', pg_column_size(p_metadata);
  end if;

  for v_key in select jsonb_object_keys(p_metadata) loop
    if jsonb_typeof(p_metadata -> v_key) not in ('string', 'number', 'boolean', 'null') then
      raise exception
        'append_audit_log: metadata must be flat — key % holds a %',
        v_key, jsonb_typeof(p_metadata -> v_key);
    end if;
    if v_key = any(v_forbidden) then
      raise exception 'append_audit_log: metadata key % is never allowed in an audit row', v_key;
    end if;
    -- Wave 2B-2a (#10): catches what the exact list cannot see — p2_child_birthdate,
    -- child_birthdate, youngest_child_birthdate, dependent_birthdate, *_birthdate_from/_to,
    -- birth_date, dob. A boolean passes so presence stays reportable.
    if v_key ~ '(birth_?date)|((^|_)dob($|_))'
       and jsonb_typeof(p_metadata -> v_key) <> 'boolean' then
      raise exception
        'append_audit_log: key % is birthdate-shaped and holds a %; a date of birth must never be '
        'stored in an append-only audit row — record presence as a boolean instead',
        v_key, jsonb_typeof(p_metadata -> v_key);
    end if;
  end loop;

  insert into audit_logs (
    actor_type, actor_id, actor_session_id, actor_role_snapshot,
    action, entity_type, entity_id, weekly_event_id,
    request_id, result, metadata_redacted
  ) values (
    p_actor_type, p_actor_id, p_actor_session_id, p_actor_role_snapshot,
    p_action, p_entity_type, p_entity_id, p_weekly_event_id,
    p_request_id, p_result, p_metadata
  )
  returning id into v_id;

  return v_id;
end $$;

-- create or replace preserves 0030's grants (EXECUTE to nobody), but re-assert rather than
-- rely on that: this function is the only path into audit_logs, and a silent grant would
-- hand the app the ability to forge rows.
revoke all on function private.append_audit_log(
  audit_actor_type, uuid, uuid, text, text, text, uuid, uuid, uuid, audit_result, jsonb
) from public, anon, authenticated, service_role;

-- ⚠️ 2B-2b's audit contract for eligibility, fixed HERE so the write RPC inherits a boundary
-- instead of inventing one. `p2_eligibility.*` metadata may carry ONLY:
--     child_birthdate_present   boolean   -- THAT a DOB is on file, never which
--     p2_valid_until_from/_to   date str  -- the derived expiry being changed
--     p2_valid_from_from/_to    date str
--     expiry_rule               text      -- e.g. 'tw_school_cohort_v1'
--     review_status_from/_to    text
-- and never a birthdate, a name, a note, or a reason's free text.
-- Known and accepted: the derived expiry discloses the child's school COHORT (birth year, and
-- which side of 9/1) — that is unavoidable, since the expiry change is the very thing being
-- audited, and it is far weaker than a DOB. Stated so it stays a decision, not an oversight.

-- ── import_member: same signature, rewritten eligibility upsert ────────────────
-- Changes vs 0029 (body only — the signature is byte-identical, see the DEPLOY note):
--   1. writes review_status = 'approved' instead of p2_eligible = true (the generated
--      column physically rejects the old write: "can only be updated to DEFAULT").
--   2. a REVOKED row is left completely alone and reported as retained_revoked. 0029:9
--      promised import never REVOKES, but nothing stopped it silently RE-GRANTING:
--      a CSV listing someone a 幹事 had revoked would flip them back to eligible and
--      wipe the review trail, with no audit row of its own. A bulk import must not
--      overturn an audited human decision.
--   3. stores p2_child_birthdate (the youngest child) so the expiry stays derivable.
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
  v_user_id          uuid;
  v_existing_name    text;
  v_status           text;
  v_plate            text;
  v_norm             text;
  v_owner            uuid;
  v_vehicles_added   int := 0;
  v_plate_conflicts  text[] := '{}';
  v_dep              jsonb;
  v_deps_added       int := 0;
  v_primary_name     text;
  v_primary_bd       date;
  v_child_bd         date;
  v_retained_p2      boolean := false;
  v_retained_revoked boolean := false;
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

    -- An explicit revoke outranks a CSV. Report it and touch nothing — dry-run and apply
    -- answer identically because this is a read.
    if v_user_id is not null then
      select true into v_retained_revoked
        from user_eligibility where user_id = v_user_id and review_status = 'revoked';
      v_retained_revoked := coalesce(v_retained_revoked, false);
    end if;

    if not p_dry_run and v_user_id is not null and not v_retained_revoked then
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
    elsif p_dependents is not null and not v_retained_revoked then
      -- Dry-run projection. `not v_retained_revoked` is what keeps dry-run == apply:
      -- a revoked member's dependents are not written on apply, so the preview must not
      -- promise they would be.
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
    'status',           v_status,
    'vehicles_added',   v_vehicles_added,
    'dependents_added', v_deps_added,
    'plate_conflicts',  to_jsonb(v_plate_conflicts),
    'retained_p2',      v_retained_p2,
    'retained_revoked', v_retained_revoked
  );
end $$;

revoke all on function import_member(text, text, text[], p2_reason, date, date, jsonb, boolean) from public;
grant execute on function import_member(text, text, text[], p2_reason, date, date, jsonb, boolean) to service_role;
