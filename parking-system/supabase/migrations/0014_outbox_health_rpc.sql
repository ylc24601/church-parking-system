-- Phase 4 Slice C — dispatcher ops hardening: operation-safe outbox health/preview.
--
-- Read-only aggregate over notification_outbox for (a) the dryRun dispatch preview and
-- (b) operational visibility (failed / retrying / stuck rows). Returns COUNTS, notification
-- TYPE names, sanitized last_error CODES, and TIMESTAMPS only — it selects no raw row column
-- (never payload_json / user_id / reservation_id / dedupe_key / line_id / plate / text). The
-- body is explicit aggregate expressions (count/min/jsonb_object_agg over grouped counts).
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
    'oldest_failed_at', (select min(created_at)   from base where status = 'failed'),
    'next_retry_at',    (select min(next_retry_at) from base where status = 'retrying')
  );
$$;

revoke all on function outbox_health(timestamptz, int) from public;
grant execute on function outbox_health(timestamptz, int) to service_role;
