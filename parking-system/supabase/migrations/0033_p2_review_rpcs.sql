-- Wave 2B-2b (#10): give 幹事 an audited way to approve/revoke P2 eligibility, and stop a
-- CSV import from overturning what they decided.
--
-- 0032 landed the MODEL and moved the church zero distance — eligibility still could not be
-- granted or revoked without re-importing a CSV. This is the slice that lifts that blocker.
--
-- ── DEPLOY: DB FIRST, then app ─────────────────────────────────────────────────
--   old app + new DB : compatible — import_member keeps its exact signature (body only),
--                      the two RPCs are brand new, so the old app merely lacks the feature.
--   new app + old DB : NOT compatible — the app selects review_version and calls the RPCs.
--   rollback         : redeploy the OLD APP against the new DB.
--
-- ── The governance boundary is ONE column: reviewed_at ─────────────────────────
-- "Has a human decided about this row?" is exactly `reviewed_at is not null`. The obvious
-- alternative, `review_version > 0`, means "an RPC wrote this" — a PROXY, and it diverges
-- the first time a data-fix migration bumps a version: those rows would freeze against
-- import though no human ever touched them. So review_version stays PURELY the optimistic
-- lock and is never a governance signal.
--
-- Consequence that makes the whole slice hang together: set_p2_eligibility MUST write
-- reviewed_by/at. An approve IS a review — if it weren't, the approval would not be
-- governed and the very next CSV would silently overwrite it.
--
-- ── Import precedence (the rule this file exists to enforce) ───────────────────
--   no row                        + CSV P2 -> insert 'approved'
--   'unreviewed'                  + CSV P2 -> becomes 'approved'
--   'approved', never hand-reviewed + CSV P2 -> refreshed by import as before
--   'approved', hand-reviewed     + CSV P2 -> retained_governed, row UNTOUCHED
--   'revoked'                     + CSV P2 -> retained_revoked,  row UNTOUCHED  (0032)
--   any                           + P1/P3  -> eligibility never touched         (0029)
-- CSV may ESTABLISH an eligibility nobody has decided on; it may not OVERWRITE a human
-- decision. 'revoked' is reported separately from 'governed' even though revoking sets
-- reviewed_at (so revoked ⊆ governed) — 「曾被同工撤銷」 and 「由同工手動維護」 are
-- different things to tell an operator.

-- ── Pre-flight ────────────────────────────────────────────────────────────────
do $$
declare
  v_bad int;
begin
  -- The pair CHECK below. Both columns have never had a writer, so this is expected to be
  -- 0 — but prod must prove it rather than inherit the assumption.
  select count(*) into v_bad from user_eligibility
   where (reviewed_at is null) <> (reviewed_by is null);
  if v_bad > 0 then
    raise exception '% eligibility row(s) have reviewed_at/reviewed_by out of step', v_bad;
  end if;

  -- The derived-expiry CHECK below. 0032's recompute should have made every child_companion
  -- row already satisfy it; if one does not, stop rather than reject a legitimate row later.
  select count(*) into v_bad from user_eligibility
   where p2_reason = 'child_companion'
     and p2_child_birthdate is not null
     and p2_valid_until is not null
     and p2_valid_until <> make_date(
           extract(year from p2_child_birthdate)::int + 6
             + case when (extract(month from p2_child_birthdate)::int,
                          extract(day   from p2_child_birthdate)::int) > (9, 1) then 1 else 0 end,
           8, 31);
  if v_bad > 0 then
    raise exception '% child_companion row(s) disagree with the cohort rule — 0032 should have recomputed them', v_bad;
  end if;
end $$;

-- ── The governance boundary, made undriftable ──────────────────────────────────
alter table user_eligibility
  add constraint eligibility_reviewed_pair_ck
  check ((reviewed_at is null) = (reviewed_by is null));

comment on column user_eligibility.reviewed_at is
  'THE governance boundary: `reviewed_at is not null` means a human has decided about this row, '
  'and import_member must then not touch any eligibility field. Deliberately NOT review_version > 0 '
  '— that means "an RPC wrote this", which is a proxy that diverges the moment a data-fix migration '
  'bumps a version. Paired with reviewed_by by eligibility_reviewed_pair_ck so the two cannot drift.';

-- ── The cohort rule becomes a DB guarantee, not a UI promise ───────────────────
-- 0032 had to state a residual: "direct SQL could desync the pair — no CHECK can catch it
-- without putting the cohort formula in SQL. The parity test is the mitigation."
-- This closes it. The rule is IMMUTABLE-safe, so a CHECK can call it, so a hand-set expiry
-- is rejected BY THE DATABASE. 幹事 may change the birthdate or the reason; nobody — not the
-- app, not psql — can hand-write a child_companion expiry that disagrees with its source.
--
-- The formula still exists twice on purpose. TS (lib/eligibilityStatus.ts
-- childCompanionValidUntil) stays authoritative for live writes AND is the only side that can
-- serve the dry-run import preview (SQL cannot). But unlike 0032's frozen one-time copy, this
-- side is now a LIVE function, so the parity test drives the real thing (2B-1's pattern).
-- If you change the rule, change both and keep tests/integration/p2-review-write.db.test.ts green.
create function child_companion_valid_until(p_birthdate date)
returns date
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  -- 國民教育法: 當年 9/1 前滿 6 歲者入學 ⇒ 9/1 INCLUSIVE is the earlier cohort, 9/2 starts the
  -- next. Eligibility runs to the 8/31 before the child enters 小一.
  select make_date(
    extract(year from p_birthdate)::int + 6
      + case when (extract(month from p_birthdate)::int,
                   extract(day   from p_birthdate)::int) > (9, 1) then 1 else 0 end,
    8, 31)
$$;

comment on function child_companion_valid_until(date) is
  'Taiwan school-year cohort: the last eligible date for a child companion, derived from the '
  'YOUNGEST child''s birthdate. 9/1 inclusive = earlier cohort; 9/2 starts the next. Mirrored by '
  'childCompanionValidUntil in lib/eligibilityStatus.ts, which serves the dry-run import preview '
  '(SQL cannot) — a parity test pins them together.';

alter table user_eligibility
  add constraint eligibility_child_expiry_derived_ck
  check (
    p2_reason <> 'child_companion'
    or p2_child_birthdate is null
    or p2_valid_until is null                       -- the review-required state stays representable
    or p2_valid_until = child_companion_valid_until(p2_child_birthdate)
  );

-- ── set_p2_eligibility ─────────────────────────────────────────────────────────
-- ⚠️ This RPC must CREATE, not only edit. A general member is a row in `users` with NO
-- user_eligibility row at all — that IS the representation (import_member's P2 path always
-- writes one; its general path writes none). An RPC that answered 'not_found' for no-row
-- could only edit members a CSV had already made P2, so 幹事 still could not grant P2 and
-- this slice would not have lifted anything.
--
-- Hence the lock is on `users`, not on the eligibility row:
--   * it exists even when the eligibility row does not, so it can serialize two 幹事
--     first-approving the same member;
--   * without it both read no-row and one hits user_eligibility_pkey — a unique violation
--     RAISES, and a raise rolls back the audit row recording the refusal (0030's rule).
--     With it, the loser re-reads under the lock and gets a typed 'conflict'.
-- Lock-order: nothing else in this repo locks `users FOR UPDATE`, and approve_pending_binding
-- locks pending_binding *then* updates users — this locks users then writes
-- user_eligibility. No cycle.
--
-- expected_version = 0 means "no row OR an import-created row still at v0" — no sentinel is
-- needed, because the RPC re-reads under the lock and the truth decides insert vs update.
--
-- Refusal classification (fixed here so no future branch invents its own):
--   bad request  (not_found, invalid_status)                  -> NOT audited; nothing was governed
--   governance   (every denied_* below)                        -> audited 'denied'
--   lost update  (version mismatch)                            -> audited 'conflict'
create function set_p2_eligibility(
  p_user_id           uuid,
  p_expected_version  int,
  p_review_status     text,
  p_reason            p2_reason,
  p_valid_from        date,
  p_valid_until       date,
  p_child_birthdate   date,
  p_next_review_date  date,
  p_note              text,
  p_acting_admin_id   uuid,
  p_acting_session_id uuid,
  p_request_id        uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_elig    user_eligibility%rowtype;
  v_exists  boolean := false;
  v_today   date;
  v_until   date;
  v_review  date;
  v_status  p2_review_status;
begin
  -- Taipei today, computed HERE and never taken from the caller: this is a guard, and a guard
  -- that trusts its caller is not a guard. `current_date` would be WRONG — the DB session is
  -- UTC, so between 00:00–08:00 Taipei it returns yesterday and would refuse a legitimate
  -- same-day review date for 8 hours daily. `at time zone` converts from the absolute instant
  -- and is therefore correct regardless of session config.
  v_today := (now() at time zone 'Asia/Taipei')::date;

  -- Lock the MEMBER (see the header) — must exist.
  perform 1 from users where id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select * into v_elig from user_eligibility where user_id = p_user_id;
  v_exists := found;

  if p_review_status not in ('approved', 'revoked') then
    return jsonb_build_object('ok', false, 'reason', 'invalid_status');
  end if;
  v_status := p_review_status::p2_review_status;

  -- Optimistic lock. For a non-existent row the expected version must be 0; anything else
  -- means the caller was looking at a row that has since been created or moved on.
  if coalesce(v_elig.review_version, 0) <> p_expected_version then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, null,
      'p2_eligibility.review_update', 'user_eligibility', p_user_id, null,
      p_request_id, 'conflict',
      jsonb_build_object('reason', 'version_conflict',
                         'expected_version', p_expected_version,
                         'actual_version', coalesce(v_elig.review_version, 0)));
    return jsonb_build_object('ok', false, 'reason', 'conflict',
                             'actual_version', coalesce(v_elig.review_version, 0));
  end if;

  -- ── Governance guards (all audited 'denied') ────────────────────────────────
  if not v_exists and v_status = 'revoked' then
    -- Revoking something that never existed would mint a 'revoked' row asserting a human took
    -- away a qualification nobody ever granted — the same fabrication 0032 refused to make.
    perform private.append_audit_log('admin', p_acting_admin_id, p_acting_session_id, null,
      'p2_eligibility.review_update', 'user_eligibility', p_user_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'nothing_to_revoke'));
    return jsonb_build_object('ok', false, 'reason', 'nothing_to_revoke');
  end if;

  if v_status = 'approved' and p_reason is null then
    perform private.append_audit_log('admin', p_acting_admin_id, p_acting_session_id, null,
      'p2_eligibility.review_update', 'user_eligibility', p_user_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'reason_required'));
    return jsonb_build_object('ok', false, 'reason', 'reason_required');
  end if;

  -- An approve is a review, so it must also decide WHEN to look again. Without this a fresh
  -- row gets p2_review_date = NULL and the queue never asks about it: the system would record
  -- 「幹事已覆核」 while never scheduling the next one.
  if v_status = 'approved' and p_next_review_date is null then
    perform private.append_audit_log('admin', p_acting_admin_id, p_acting_session_id, null,
      'p2_eligibility.review_update', 'user_eligibility', p_user_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'review_date_required'));
    return jsonb_build_object('ok', false, 'reason', 'review_date_required');
  end if;

  if p_next_review_date is not null and p_next_review_date < v_today then
    perform private.append_audit_log('admin', p_acting_admin_id, p_acting_session_id, null,
      'p2_eligibility.review_update', 'user_eligibility', p_user_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'review_date_in_past'));
    return jsonb_build_object('ok', false, 'reason', 'review_date_in_past');
  end if;

  -- Typed even though eligibility_child_birthdate_reason_ck would also catch it: a constraint
  -- error RAISES, which means a 500 and the audit row rolled back with it. The CHECK is the
  -- backstop, not the messenger.
  if v_status = 'approved' and p_reason <> 'child_companion' and p_child_birthdate is not null then
    perform private.append_audit_log('admin', p_acting_admin_id, p_acting_session_id, null,
      'p2_eligibility.review_update', 'user_eligibility', p_user_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'child_birthdate_not_applicable'));
    return jsonb_build_object('ok', false, 'reason', 'child_birthdate_not_applicable');
  end if;

  if v_status = 'approved' and p_reason = 'child_companion' then
    -- 「不可覛改」 is refused LOUDLY rather than silently ignored: a caller who passes an
    -- expiry believes they set it.
    if p_valid_until is not null then
      perform private.append_audit_log('admin', p_acting_admin_id, p_acting_session_id, null,
        'p2_eligibility.review_update', 'user_eligibility', p_user_id, null,
        p_request_id, 'denied', jsonb_build_object('reason', 'expiry_not_settable'));
      return jsonb_build_object('ok', false, 'reason', 'expiry_not_settable');
    end if;
    if p_child_birthdate is null then
      perform private.append_audit_log('admin', p_acting_admin_id, p_acting_session_id, null,
        'p2_eligibility.review_update', 'user_eligibility', p_user_id, null,
        p_request_id, 'denied', jsonb_build_object('reason', 'child_birthdate_required'));
      return jsonb_build_object('ok', false, 'reason', 'child_birthdate_required');
    end if;
    if p_child_birthdate > v_today then
      perform private.append_audit_log('admin', p_acting_admin_id, p_acting_session_id, null,
        'p2_eligibility.review_update', 'user_eligibility', p_user_id, null,
        p_request_id, 'denied', jsonb_build_object('reason', 'child_birthdate_in_future'));
      return jsonb_build_object('ok', false, 'reason', 'child_birthdate_in_future');
    end if;
  end if;

  -- The expiry is DERIVED for child_companion and caller-supplied otherwise.
  v_until := case when v_status = 'approved' and p_reason = 'child_companion'
                  then child_companion_valid_until(p_child_birthdate)
                  else p_valid_until end;

  if p_valid_from is not null and v_until is not null and p_valid_from > v_until then
    perform private.append_audit_log('admin', p_acting_admin_id, p_acting_session_id, null,
      'p2_eligibility.review_update', 'user_eligibility', p_user_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'window_inverted'));
    return jsonb_build_object('ok', false, 'reason', 'window_inverted');
  end if;

  -- A revoked row has no P2 left to re-check, so a lingering review date would be a lie.
  -- (The queue already excludes it via p2_eligible, but that filter is not this invariant.)
  -- p2_valid_from/until are KEPT as the historical record of what the eligibility was.
  v_review := case when v_status = 'revoked' then null else p_next_review_date end;

  -- ── No-op: only meaningful for an existing row, and checked AFTER every guard ─
  -- reviewed_at is deliberately NOT touched here. Opening the form and changing nothing is
  -- not a review — recording 「我看過了」 is mark_p2_reviewed's job. That separation is
  -- exactly 「標記已覆核」≠「核准」, and it is why the UI must offer both.
  if v_exists
     and v_elig.review_status = v_status
     and v_elig.p2_reason is not distinct from (case when v_status = 'approved' then p_reason else v_elig.p2_reason end)
     and v_elig.p2_valid_from is not distinct from p_valid_from
     and v_elig.p2_valid_until is not distinct from v_until
     and v_elig.p2_review_date is not distinct from v_review
     and v_elig.p2_child_birthdate is not distinct from p_child_birthdate
     and v_elig.review_note is not distinct from p_note
  then
    return jsonb_build_object('ok', true, 'noop', true, 'review_version', v_elig.review_version);
  end if;

  if v_exists then
    update user_eligibility
       set review_status      = v_status,
           p2_reason          = case when v_status = 'approved' then p_reason else p2_reason end,
           p2_valid_from      = p_valid_from,
           p2_valid_until     = v_until,
           p2_review_date     = v_review,
           p2_child_birthdate = p_child_birthdate,
           review_note        = p_note,
           reviewed_by        = p_acting_admin_id,
           reviewed_at        = now(),
           review_version     = review_version + 1
     where user_id = p_user_id;
  else
    insert into user_eligibility (
      user_id, review_status, p2_reason, p2_valid_from, p2_valid_until, p2_review_date,
      p2_child_birthdate, review_note, reviewed_by, reviewed_at, review_version)
    values (
      p_user_id, v_status, p_reason, p_valid_from, v_until, v_review,
      p_child_birthdate, p_note, p_acting_admin_id, now(), 1);
  end if;

  perform private.append_audit_log(
    'admin', p_acting_admin_id, p_acting_session_id, null,
    'p2_eligibility.review_update', 'user_eligibility', p_user_id, null,
    p_request_id, 'success',
    jsonb_build_object(
      -- Enum values and dates only. child_birthdate_present / note_present record THAT the
      -- data exists, never what it says — 0032's sanitizer rejects a birthdate value outright
      -- and 0030 exact-key denies note/review_note.
      'review_status_from',     case when v_exists then v_elig.review_status::text else null end,
      'review_status_to',       v_status::text,
      'reason_from',            case when v_exists then v_elig.p2_reason::text else null end,
      'reason_to',              case when v_status = 'approved' then p_reason::text
                                     when v_exists then v_elig.p2_reason::text else null end,
      'p2_valid_from_from',     case when v_exists then v_elig.p2_valid_from::text else null end,
      'p2_valid_from_to',       p_valid_from::text,
      'p2_valid_until_from',    case when v_exists then v_elig.p2_valid_until::text else null end,
      'p2_valid_until_to',      v_until::text,
      'p2_review_date_from',    case when v_exists then v_elig.p2_review_date::text else null end,
      'p2_review_date_to',      v_review::text,
      'child_birthdate_present', p_child_birthdate is not null,
      'note_present',           p_note is not null and length(trim(p_note)) > 0,
      'created',                not v_exists));

  return jsonb_build_object('ok', true, 'noop', false,
                           'review_version', coalesce(v_elig.review_version, 0) + 1);
end $$;

revoke all on function set_p2_eligibility(uuid, int, text, p2_reason, date, date, date, date, text, uuid, uuid, uuid) from public;
grant execute on function set_p2_eligibility(uuid, int, text, p2_reason, date, date, date, date, text, uuid, uuid, uuid) to service_role;

-- ── mark_p2_reviewed ───────────────────────────────────────────────────────────
-- 「標記已覆核」≠「核准」. This records the FACT that a human looked and decided nothing
-- needed changing, plus when to look next.
--
-- ⚠️ NEVER INERT — 0031's no-op rule must NOT be copied onto this function. Submitting the
-- same next-review date twice is two real reviews on two different days, and suppressing the
-- second would erase a governance fact. Same shape as set_admin_disabled's unconditional
-- session revoke (0026:69), which 0030 already documents as the reason a "no-op" can still be
-- a real action.
--
-- Guarded on `<> 'approved'`, not `= 'revoked'`: an ALLOWLIST, so #11's pending /
-- needs_information / rejected fail closed instead of silently becoming reviewable — the same
-- reason 0031's editable-status check is `not in ('open')`. Without this guard the function
-- would refill p2_review_date on a revoked row and break, one action later, the invariant
-- set_p2_eligibility just established by clearing it.
create function mark_p2_reviewed(
  p_user_id           uuid,
  p_expected_version  int,
  p_next_review_date  date,
  p_acting_admin_id   uuid,
  p_acting_session_id uuid,
  p_request_id        uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_elig  user_eligibility%rowtype;
  v_today date;
begin
  v_today := (now() at time zone 'Asia/Taipei')::date;   -- never current_date; see set_p2_eligibility

  perform 1 from users where id = p_user_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  select * into v_elig from user_eligibility where user_id = p_user_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_elig.review_version <> p_expected_version then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, null,
      'p2_eligibility.marked_reviewed', 'user_eligibility', p_user_id, null,
      p_request_id, 'conflict',
      jsonb_build_object('reason', 'version_conflict',
                         'expected_version', p_expected_version,
                         'actual_version', v_elig.review_version));
    return jsonb_build_object('ok', false, 'reason', 'conflict',
                             'actual_version', v_elig.review_version);
  end if;

  if v_elig.review_status <> 'approved' then
    perform private.append_audit_log('admin', p_acting_admin_id, p_acting_session_id, null,
      'p2_eligibility.marked_reviewed', 'user_eligibility', p_user_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'eligibility_not_approved'));
    return jsonb_build_object('ok', false, 'reason', 'eligibility_not_approved');
  end if;

  if p_next_review_date is null then
    return jsonb_build_object('ok', false, 'reason', 'review_date_required');
  end if;

  -- A past date re-queues the row the moment it is written, which is almost always a typo.
  if p_next_review_date < v_today then
    perform private.append_audit_log('admin', p_acting_admin_id, p_acting_session_id, null,
      'p2_eligibility.marked_reviewed', 'user_eligibility', p_user_id, null,
      p_request_id, 'denied', jsonb_build_object('reason', 'review_date_in_past'));
    return jsonb_build_object('ok', false, 'reason', 'review_date_in_past');
  end if;

  update user_eligibility
     set p2_review_date = p_next_review_date,
         reviewed_by    = p_acting_admin_id,
         reviewed_at    = now(),
         review_version = review_version + 1
   where user_id = p_user_id;

  perform private.append_audit_log(
    'admin', p_acting_admin_id, p_acting_session_id, null,
    'p2_eligibility.marked_reviewed', 'user_eligibility', p_user_id, null,
    p_request_id, 'success',
    jsonb_build_object(
      'p2_review_date_from', v_elig.p2_review_date::text,
      'p2_review_date_to',   p_next_review_date::text));

  return jsonb_build_object('ok', true, 'review_version', v_elig.review_version + 1);
end $$;

revoke all on function mark_p2_reviewed(uuid, int, date, uuid, uuid, uuid) from public;
grant execute on function mark_p2_reviewed(uuid, int, date, uuid, uuid, uuid) to service_role;

-- ── import_member: same signature, precedence added ────────────────────────────
-- Change vs 0032 (body only — the signature is byte-identical, see the DEPLOY note):
-- a GOVERNED row (reviewed_at is not null) is now left completely alone and reported as
-- retained_governed, exactly as a 'revoked' row already was.
--
-- Why this is needed the moment 2B-2b ships: `on conflict do update` rewrites p2_reason,
-- p2_valid_until and p2_review_date. Before this slice nothing could hand-set those, so
-- overwriting them lost nothing. Now a 幹事 can — and the next CSV would silently reset their
-- decision, with import writing NO audit row of its own. Import may ESTABLISH an eligibility
-- nobody has decided on; it may not OVERWRITE a human decision.
--
-- Dependents freeze WITH the row: eligibility_dependents is the evidence p2_child_birthdate
-- derives from, so writing dependents while freezing the source lets max(child birthdate) and
-- the stored source disagree — the dual truth #10 exists to kill.
-- users/vehicles still update above: a name or a plate is not governance.
--
-- 'revoked' is checked BEFORE 'governed'. Revoking sets reviewed_at, so revoked ⊆ governed —
-- but 「曾被同工撤銷」 and 「由同工手動維護」 are different things to tell an operator, and
-- collapsing them into one bucket would lose the more specific one.
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
