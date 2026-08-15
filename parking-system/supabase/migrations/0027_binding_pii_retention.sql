-- Phase 8 Slice 7: PII retention for pending_binding (binding-ops.md「PII 保留」).
-- claimed_phone / claimed_name / submitted_code live ONLY in pending_binding and are
-- kept after an approve/reject decision for audit. Policy: 90 days after the decision
-- they must be cleared, while keeping claim_source, timestamps, status, approved_user_id,
-- rejected_reason and decided_by_admin_id.
--
-- This migration:
--   (1) widens pending_binding_claim_shape_ck with a third legal shape — "redacted",
--       allowed ONLY for decided rows (a pending row can never be redacted at the DB
--       layer, and partial redaction — e.g. phone cleared but name kept — is illegal);
--   (2) adds redact_decided_binding_pii — the bounded, idempotent retention RPC;
--   (3) adds a partial index matching the retention scan predicate (this job runs
--       daily forever; the index shrinks to nothing once a row is redacted).

-- ── (1) claim-shape constraint: keyword XOR liff XOR redacted-decided ─────────────
alter table pending_binding drop constraint pending_binding_claim_shape_ck;
alter table pending_binding add constraint pending_binding_claim_shape_ck check (
  (claim_source = 'keyword' and submitted_code is not null and claimed_phone is null and claimed_name is null)
  or
  (claim_source = 'liff' and submitted_code is null and claimed_phone is not null and claimed_name is not null)
  or
  (status in ('approved', 'rejected')
    and submitted_code is null and claimed_phone is null and claimed_name is null)
);

-- ── (2) redact_decided_binding_pii — bounded PII retention sweep ──────────────────
-- Clears the three claim columns on rows decided (approved/rejected) at least
-- p_retention_days ago. Conservative and idempotent:
--   * every parameter is explicitly null-guarded — under SQL three-valued logic a
--     bare `p_retention_days < 30` is NULL (not true) for a NULL input, so without
--     the explicit checks a NULL argument would silently skip the guard;
--   * p_retention_days has a HARD floor of 30 here (defense in depth: no caller —
--     not even one holding the job secret — can shorten the window to wipe fresh
--     audit data early; the service enforces the same floor on the env value);
--   * the dry-run and apply paths share the same predicate, so the preview count
--     can never drift from what apply would touch;
--   * dry-run probes at most p_max+1 rows (LIMIT) instead of counting the full
--     matching set — `count` is THIS batch's size, `has_more` flags a backlog;
--   * apply is bounded (LIMIT p_max), oldest decision first, FOR UPDATE SKIP LOCKED
--     so it never fights a concurrent approve/reject or a second retention run;
--   * only the three claim columns are written — status, claim_source, timestamps,
--     approved_user_id, rejected_reason, decided_by_admin_id are untouched;
--   * re-running is a cheap no-op: already-redacted rows fail the IS NOT NULL arm.
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

  if p_dry_run then
    -- Probe p_max+1 rows, not count(*) over the whole matching set.
    select count(*) from (
      select 1 from pending_binding
       where status in ('approved', 'rejected')
         and coalesce(approved_at, rejected_at) <= v_cutoff
         and (claimed_phone is not null or claimed_name is not null or submitted_code is not null)
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
       and (claimed_phone is not null or claimed_name is not null or submitted_code is not null)
     order by coalesce(approved_at, rejected_at)
     limit p_max
     for update skip locked
  ),
  done as (
    update pending_binding b set
      claimed_phone  = null,
      claimed_name   = null,
      submitted_code = null
    from target
    where b.id = target.id
    returning 1
  )
  select count(*) from done into v_count;
  return jsonb_build_object('count', v_count, 'has_more', false);
end $$;

revoke all on function redact_decided_binding_pii(timestamptz, int, int, boolean) from public;
grant execute on function redact_decided_binding_pii(timestamptz, int, int, boolean) to service_role;

-- ── (3) partial index for the retention scan ──────────────────────────────────────
create index pending_binding_pii_retention_idx
  on pending_binding ((coalesce(approved_at, rejected_at)))
  where status in ('approved', 'rejected')
    and (claimed_phone is not null or claimed_name is not null or submitted_code is not null);
