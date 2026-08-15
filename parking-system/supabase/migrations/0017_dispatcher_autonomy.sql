-- Phase 4 Slice F: dispatcher autonomy (health alerting + dead-letter requeue).
-- Two changes, both operation-safe (aggregate / counts only, no raw row columns exposed):
--   (1) extend outbox_health with `oldest_due_at` — the oldest row that is DUE now, so the alert's
--       "backlog not draining" signal ignores intentionally future-scheduled rows.
--   (2) requeue_failed_outbox — a conservative, manual-only recovery lever: failed → pending.

-- ── (1) outbox_health + oldest_due_at ────────────────────────────────────────────────────────────
-- Same body as 0014 plus `oldest_due_at = min(created_at) over is_due rows`. `is_due` already
-- requires next_retry_at <= now, so future-scheduled retrying rows are excluded.
create or replace function outbox_health(
  p_now           timestamptz,
  p_lease_seconds int
) returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  with base as (
    select status,
           template_key,
           last_error,
           next_retry_at,
           created_at,
           sent_at,
           locked_at,
           (    (status in ('pending', 'retrying') and next_retry_at <= p_now)
             or (status = 'processing' and locked_at < p_now - make_interval(secs => p_lease_seconds))
           ) as is_due,
           (status = 'processing' and locked_at < p_now - make_interval(secs => p_lease_seconds)) as is_stale
      from notification_outbox
  )
  select jsonb_build_object(
    'due',              (select count(*) from base where is_due),
    'due_by_template',  coalesce((select jsonb_object_agg(template_key, c)
                                    from (select template_key, count(*) c from base where is_due group by template_key) t),
                                 '{}'::jsonb),
    'pending',          (select count(*) from base where status = 'pending'),
    'retrying',         (select count(*) from base where status = 'retrying'),
    'processing',       (select count(*) from base where status = 'processing'),
    'stale_processing', (select count(*) from base where is_stale),
    'failed',           (select count(*) from base where status = 'failed'),
    'failed_by_error',  coalesce((select jsonb_object_agg(coalesce(last_error, 'unknown'), c)
                                    from (select last_error, count(*) c from base where status = 'failed' group by last_error) t),
                                 '{}'::jsonb),
    'sent_last_24h',    (select count(*) from base where status = 'sent' and sent_at >= p_now - interval '24 hours'),
    'oldest_pending_at',(select min(created_at)   from base where status = 'pending'),
    'oldest_due_at',    (select min(created_at)   from base where is_due),
    'oldest_failed_at', (select min(created_at)   from base where status = 'failed'),
    'next_retry_at',    (select min(next_retry_at) from base where status = 'retrying')
  );
$$;

revoke all on function outbox_health(timestamptz, int) from public;
grant execute on function outbox_health(timestamptz, int) to service_role;

-- ── (2) requeue_failed_outbox — manual-only dead-letter recovery ──────────────────────────────────
-- Resets terminal `failed` rows back to `pending` for a fresh delivery attempt, AFTER the root cause
-- (token/config/provider) has been fixed. Conservative and non-destructive:
--   * ONLY status='failed' rows are touched (WHERE guard) — never sent/processing/pending/retrying.
--   * optional sanitized last_error filter; bounded by p_max (caller hard-caps at 500).
--   * FOR UPDATE SKIP LOCKED so it never fights an in-flight dispatcher claim.
--   * resets retry_count / next_retry_at / locked_at / locked_by / last_error; no DELETE.
create or replace function requeue_failed_outbox(
  p_now         timestamptz,
  p_max         int,
  p_error_code  text        -- null = all failed; else exact sanitized last_error match
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_requeued int;
begin
  with target as (
    select id from notification_outbox
     where status = 'failed'
       and (p_error_code is null or last_error = p_error_code)
     order by created_at
     limit greatest(p_max, 0)
     for update skip locked
  ),
  done as (
    update notification_outbox o set
      status        = 'pending',
      retry_count   = 0,
      next_retry_at = p_now,
      locked_at     = null,
      locked_by     = null,
      last_error    = null
    from target
    where o.id = target.id
    returning 1
  )
  select count(*) from done into v_requeued;
  return jsonb_build_object('requeued', v_requeued);
end $$;

revoke all on function requeue_failed_outbox(timestamptz, int, text) from public;
grant execute on function requeue_failed_outbox(timestamptz, int, text) to service_role;
