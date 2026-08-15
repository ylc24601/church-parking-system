-- Wave 2B-1 (#14A): let a 幹事 change a week's parking capacity from the Admin UI
-- instead of hand-written SQL. Until now the only way was literally what the runbook
-- told operators to do — `UPDATE weekly_events SET blocked_spaces=21 WHERE id=...`.
-- The second audited governance RPC (0030 built the substrate and names #14A in its
-- header); the first one written from scratch rather than retrofitted.
--
-- ── DEPLOY: additive for functions, so NO compatibility window ──────────────────
-- Unlike 0030, this adds a BRAND-NEW RPC and replaces no signature, so old app + new
-- DB and new app + old DB both merely lack the feature — nothing breaks. It does
-- mutate data (the fold below) and add a constraint, hence the pre-flight assertions.
--
-- ── The invariant this slice defends ────────────────────────────────────────────
--   effective = total_capacity − blocked_spaces − admin_reserved − reserved_staff
--   effective >= promised, where promised = count(approved) + count(temp_approved)
--
-- and the reason it needs a lock, not just a check:
--
-- WRITER INVENTORY — which paths can raise `promised`? (verified, 2026-07-17)
--   apply_friday_allocation (0005)   NET INCREASE: pending -> approved. Takes NO
--                                    weekly_events lock of its own.
--   apply_cancellation (0006:21-37)  net zero — the promote runs only if the cancel
--                                    did: `and (select count(*) from cancelled) = 1`
--   apply_release (0007:21-35)       net zero — releases an approved, promotes a waiting
--   apply_offer_resolution (0006:106),
--   offer-expiry guard (0024:41)     net zero/decrease — temp_approved -> approved is a
--                                    transition, not a new seat
--   apply_reservation (0023)         none — writes `pending`; already locks the event row
--   walk-in / attendance / settlement none/decrease — walk_in isn't promised;
--                                    approved -> attended/no_show
--
-- So exactly ONE path net-increases promised, and this RPC gates it by refusing while
-- a friday_allocation job is `running`. The event-row lock is what makes that job_runs
-- read trustworthy — see 0023:14-21: READ COMMITTED hides a concurrently-claiming
-- uncommitted 'running' row, so claim_friday_allocation (0023:96) and this function
-- serialize on the same weekly_events row.
--
-- ⚠️ THIS GUARD DEPENDS ON THAT PROPERTY. Any future path that net-increases
-- `promised` MUST take the weekly_events row lock first, or this silently stops
-- working: COUNT() locks no rows that don't exist yet.
--
-- ── Why the capacity formula now exists TWICE, on purpose ───────────────────────
-- 0004:5-7 states the opposite decision: "v_weekly_capacity_inputs (Seam 4: supplies
-- inputs, NOT the formula) — the arithmetic stays in the Phase 0 pure computeCapacity
-- (single source of the formula)", and tests/unit/allocation/deadlines.test.ts:49-51
-- encodes it. That decision is right for the READ path and stays untouched:
-- fridayAllocationService still reads the view and calls computeCapacity.
--
-- But a guard that runs in the app is bypassable and cannot be transactional, and it
-- must not trust a capacity number passed in by the caller — so the guard has to
-- recompute here, in SQL, inside the transaction. Both formulas are therefore
-- deliberate, and tests/integration/weekly-capacity.db.test.ts drives BOTH from one
-- shared fixture table and asserts they agree. That parity test is the whole
-- mitigation; if you change either formula, change both and keep it green.
-- (See lib/allocation/allocate.ts:24 for the other half.)

-- ── Pre-flight: fail loudly rather than corrupt ─────────────────────────────────
-- The CHECK below and the fold both assume the existing rows are already sane. Assert
-- it against the FULL formula (including reserved_staff, which the CHECK itself cannot
-- see — see the constraint comment).
do $$
declare v_bad int;
begin
  select count(*) into v_bad
    from v_weekly_capacity_inputs
   where total_capacity - blocked_spaces - admin_reserved - active_full_time_staff_reserved < 0;
  if v_bad > 0 then
    raise exception
      '% weekly_events row(s) already imply negative effective capacity — fix them before this migration', v_bad;
  end if;

  select count(*) into v_bad
    from weekly_events where blocked_spaces + admin_reserved > total_capacity;
  if v_bad > 0 then
    raise exception
      '% weekly_events row(s) already exceed total_capacity — the new CHECK would reject them', v_bad;
  end if;
end $$;

-- ── Fold admin_reserved into blocked_spaces (arithmetic-preserving) ─────────────
-- #14A shows the 幹事 ONE 「保留·停用」number and deliberately does not split
-- 外賓/維修 (feature-triage #14A, and #8's「對齊 #14A 單一 blocked」). But
-- admin_reserved was still LIVE in the formula, so a form editing only blocked_spaces
-- would have shown a preview that quietly disagreed with the allocator.
--
-- The fold changes NO effective capacity, for any row, past or future:
--   before: total − blocked − admin_reserved − staff
--   after:  total − (blocked + admin_reserved) − 0 − staff     ← identical
-- What is lost is only the 外賓-vs-停用 attribution, which the triage already decided
-- not to surface. Nothing is recomputed and no history is revalued.
-- ── Fold marker: one aggregate audit row, never one per event ───────────────────
-- The fold rewrites a column's meaning across every historical row. Effective capacity
-- is unchanged, but the audit timeline should still be able to explain why 外賓 stopped
-- appearing separately from this instant. Aggregate only: a count, never row ids.
--
-- The count comes from GET DIAGNOSTICS on the fold itself — the only number that is
-- actually "rows this migration changed". (Counting rows afterwards cannot express it:
-- by then every admin_reserved is 0, and counting anything else would put a
-- plausible-looking but wrong number into an audit record, which is worse than
-- recording none.) On a fresh local db:reset this is legitimately 0 — migrations run
-- before seed.sql, so there are no rows yet to fold.
do $$
declare v_rows int;
begin
  update weekly_events
     set blocked_spaces = blocked_spaces + admin_reserved,
         admin_reserved = 0
   where admin_reserved <> 0;
  get diagnostics v_rows = row_count;

  perform private.append_audit_log(
    'system', null, null, null,
    'weekly_event.admin_reserved_fold', 'weekly_event', null, null,
    gen_random_uuid(), 'success',
    jsonb_build_object('rows_affected', v_rows, 'arithmetic_preserved', true)
  );
end $$;

-- Now that every row is 0, pin it: the formula's admin_reserved term is PROVABLY
-- inert, so the single number the 幹事 edits is provably the whole story. Retiring the
-- column outright would touch 0004's view, computeCapacity's signature and three test
-- files — a real simplification, but its own slice.
alter table weekly_events
  add constraint weekly_events_admin_reserved_folded_ck check (admin_reserved = 0);

-- The row-local half of the invariant. This is all a CHECK can enforce: reserved_staff
-- is NOT a column here — it is a count over weekly_staff_allocations (0004:13-19) — and
-- a CHECK cannot subquery another table. The full cross-table invariant lives in the
-- RPC below. Residual gap, stated rather than hidden: nothing stops a direct INSERT
-- into weekly_staff_allocations from driving effective capacity negative. No
-- application code writes that table today (seed/SQL only), so the exposure is manual
-- SQL — the same class this constraint closes for the columns it CAN see. Closing it
-- properly needs triggers on both tables and belongs to whichever slice gives staff
-- allocations a writer.
--
-- Why it matters: computeCapacity THROWS on negative (allocate.ts:37), so a careless
-- manual UPDATE could brick Friday allocation. Per-column non-negative checks already
-- exist (0002:10-12) and are not duplicated here.
alter table weekly_events
  add constraint weekly_events_blocked_within_total_ck
  check (blocked_spaces + admin_reserved <= total_capacity);

-- Optimistic concurrency. No table in this repo has a `version` column; the established
-- idiom is a monotonic counter + a caller-supplied expected value, compared inside a
-- FOR UPDATE-locked RPC that RETURNS a typed reason rather than raising
-- (approve_pending_binding, 0022:118-155). This follows that shape rather than
-- inventing a second one. It also makes audit_result's 'conflict' real rather than
-- aspirational: two 幹事 editing the same week now collide visibly instead of one
-- silently overwriting the other.
alter table weekly_events add column capacity_version int not null default 0;

-- ── set_weekly_capacity ─────────────────────────────────────────────────────────
-- SECURITY DEFINER because private.append_audit_log grants EXECUTE to NOBODY (0030) —
-- only an owner-controlled function can reach the audit writer, and it must do so
-- inside this transaction so the change and its record commit or roll back together.
--
-- Every refusal is a TYPED RETURN, never a raise: a raise would roll back the very
-- audit row that records the refusal (0030:288-295). Only genuine infrastructure
-- failure may raise here.
--
-- Which refusals are audited is fixed here so no future branch invents its own rule:
--   input / stale request  (not_found, sunday_mismatch)  -> NOT audited; nothing was governed
--   governance refusal     (event_not_editable, allocation_in_progress,
--                           negative_capacity, capacity_below_promised) -> audited 'denied'
--   lost update            (capacity_version mismatch)   -> audited 'conflict'
create function set_weekly_capacity(
  p_event_id          uuid,
  p_sunday            date,
  p_total_capacity    int,
  p_blocked_spaces    int,
  p_expected_version  int,
  p_acting_admin_id   uuid,
  p_acting_session_id uuid,
  p_request_id        uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_event      weekly_events%rowtype;
  v_staff      int;
  v_effective  int;
  v_eff_before int;
  v_promised   int;
begin
  -- Serializes against claim_friday_allocation (0023:96), which locks this same row
  -- before marking the job 'running'. Without this lock the job_runs read below could
  -- miss an allocation that is claiming concurrently (READ COMMITTED hides its
  -- uncommitted row) — see 0023:14-21.
  select * into v_event from weekly_events where id = p_event_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Re-verify the {eventId, sunday} pair the admin actually SAW, server-side
  -- (staffPinAdminService.ts:61 precedent). A stale tab must not edit a different week.
  if v_event.sunday_date <> p_sunday then
    return jsonb_build_object('ok', false, 'reason', 'sunday_mismatch');
  end if;

  -- ALLOWLIST, not `<> 'finalized'`. A future 'closed'/'archived'/'settling' must not
  -- become silently editable because nobody remembered to exclude it; unknown status
  -- fails closed. ('closed' exists in the enum but is never written today — only
  -- 'finalized' is — so if it ever starts being used, someone has to decide.)
  if v_event.status not in ('open') then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, null,
      'weekly_event.capacity_update', 'weekly_event', p_event_id, p_event_id,
      p_request_id, 'denied', jsonb_build_object('reason', 'event_not_editable'));
    return jsonb_build_object('ok', false, 'reason', 'event_not_editable');
  end if;

  if v_event.capacity_version <> p_expected_version then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, null,
      'weekly_event.capacity_update', 'weekly_event', p_event_id, p_event_id,
      p_request_id, 'conflict',
      jsonb_build_object('reason', 'version_conflict',
                         'expected_version', p_expected_version,
                         'actual_version', v_event.capacity_version));
    return jsonb_build_object('ok', false, 'reason', 'conflict',
                             'actual_version', v_event.capacity_version);
  end if;

  -- The one path that net-increases `promised` (see the writer inventory above).
  -- Between its claim committing and its apply landing, the seats it is about to
  -- create are not countable yet — so refuse rather than guess.
  if exists (
    select 1 from job_runs
     where weekly_event_id = p_event_id and job_type = 'friday_allocation' and status = 'running'
  ) then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, null,
      'weekly_event.capacity_update', 'weekly_event', p_event_id, p_event_id,
      p_request_id, 'denied', jsonb_build_object('reason', 'allocation_in_progress'));
    return jsonb_build_object('ok', false, 'reason', 'allocation_in_progress');
  end if;

  select count(*) into v_staff
    from weekly_staff_allocations
   where weekly_event_id = p_event_id and status = 'reserved';

  -- The deliberate second formula. Mirrors lib/allocation/allocate.ts:24 exactly; the
  -- parity test is what keeps them honest.
  v_effective  := p_total_capacity     - p_blocked_spaces     - v_event.admin_reserved - v_staff;
  v_eff_before := v_event.total_capacity - v_event.blocked_spaces - v_event.admin_reserved - v_staff;

  if v_effective < 0 then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, null,
      'weekly_event.capacity_update', 'weekly_event', p_event_id, p_event_id,
      p_request_id, 'denied',
      jsonb_build_object('reason', 'negative_capacity',
                         'requested_effective_capacity', v_effective));
    return jsonb_build_object('ok', false, 'reason', 'negative_capacity');
  end if;

  -- temp_approved HOLDS A SEAT: a cancellation promotes a waiting row straight into it
  -- (0006:26-36) and apply_offer_resolution flips it to approved with NO capacity check
  -- (0006:104-119). Counting only 'approved' would let capacity be cut during a live
  -- Saturday offer window and oversubscribe the moment that offer confirms.
  select count(*) into v_promised
    from reservations
   where weekly_event_id = p_event_id and status in ('approved', 'temp_approved');

  if v_effective < v_promised then
    perform private.append_audit_log(
      'admin', p_acting_admin_id, p_acting_session_id, null,
      'weekly_event.capacity_update', 'weekly_event', p_event_id, p_event_id,
      p_request_id, 'denied',
      jsonb_build_object('reason', 'capacity_below_promised',
                         'requested_effective_capacity', v_effective,
                         'promised_count', v_promised));
    return jsonb_build_object('ok', false, 'reason', 'capacity_below_promised',
                             'effective_capacity', v_effective, 'promised_count', v_promised);
  end if;

  -- No-op check comes AFTER every guard, deliberately: submitting unchanged values for
  -- a finalized event must answer "not editable", not "ok". A genuinely inert resubmit
  -- writes nothing and bumps nothing (0030:368) — unlike admin_account.disable, whose
  -- "no-op" still revokes sessions and therefore still earns a row.
  if v_event.total_capacity = p_total_capacity and v_event.blocked_spaces = p_blocked_spaces then
    return jsonb_build_object('ok', true, 'noop', true,
                             'effective_capacity', v_effective,
                             'promised_count', v_promised,
                             'capacity_version', v_event.capacity_version);
  end if;

  update weekly_events
     set total_capacity   = p_total_capacity,
         blocked_spaces   = p_blocked_spaces,
         capacity_version = capacity_version + 1
   where id = p_event_id;

  -- effective_capacity_from/to are BOTH recorded so the audit viewer never has to
  -- recompute the formula — presentation must not become a third place it lives.
  perform private.append_audit_log(
    'admin', p_acting_admin_id, p_acting_session_id, null,
    'weekly_event.capacity_update', 'weekly_event', p_event_id, p_event_id,
    p_request_id, 'success',
    jsonb_build_object(
      'total_capacity_from', v_event.total_capacity, 'total_capacity_to', p_total_capacity,
      'blocked_spaces_from', v_event.blocked_spaces, 'blocked_spaces_to', p_blocked_spaces,
      'effective_capacity_from', v_eff_before, 'effective_capacity_to', v_effective,
      'promised_count', v_promised));

  return jsonb_build_object('ok', true, 'noop', false,
                           'effective_capacity', v_effective,
                           'promised_count', v_promised,
                           'capacity_version', v_event.capacity_version + 1);
end $$;

revoke all on function set_weekly_capacity(uuid, date, int, int, int, uuid, uuid, uuid) from public;
grant execute on function set_weekly_capacity(uuid, date, int, int, int, uuid, uuid, uuid) to service_role;
