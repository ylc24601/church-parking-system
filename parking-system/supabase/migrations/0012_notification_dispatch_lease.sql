-- Phase 4 Slice A — notification dispatcher lease + atomic claim.
--
-- notification_outbox (0003) is written by allocation/offer/release/reminder but nothing
-- ever sends it. The dispatcher must not double-push under concurrent workers, so it
-- CLAIMS a batch of due rows atomically (flip to 'processing' + stamp a lease) BEFORE the
-- external LINE call. FOR UPDATE SKIP LOCKED means a second concurrent claim skips in-flight
-- rows and (post-commit) sees them as 'processing', so it claims nothing.
--
-- notification_outbox is covered by 0004's `grant ... on all tables ... to service_role`
-- (column grants inherit), so the new columns need no extra table grant — only the new
-- function needs an explicit execute grant (0004's blanket grant is point-in-time).

alter table notification_outbox
  add column locked_at  timestamptz,
  add column locked_by  text,
  add column last_error text;               -- sanitized classification code only (never raw body / text / line_id)

-- Stale-lease reclaim sweep: find 'processing' rows whose owner crashed (locked_at old).
create index notification_outbox_lease_idx
  on notification_outbox (locked_at) where status = 'processing';

-- Atomically claim up to p_limit due rows for one worker. "Due" = pending/retrying past
-- next_retry_at, OR a 'processing' row whose lease has expired (owner presumed dead).
-- Returns the claimed rows joined to the recipient's line_id so the dispatcher needs no
-- extra round-trip. The claim UPDATE + FOR UPDATE SKIP LOCKED is the mutual-exclusion seam.
create or replace function claim_notification_outbox(
  p_worker        text,
  p_now           timestamptz,
  p_limit         int,
  p_lease_seconds int
) returns table (
  id           uuid,
  template_key text,
  user_id      uuid,
  line_id      text,
  payload_json jsonb,
  retry_count  int,
  dedupe_key   text
)
language plpgsql
set search_path = public, pg_temp
as $$
begin
  return query
  with due as (
    select o.id
      from notification_outbox o
     where ( o.status in ('pending', 'retrying') and o.next_retry_at <= p_now )
        or ( o.status = 'processing'
             and o.locked_at < p_now - make_interval(secs => p_lease_seconds) )
     order by o.next_retry_at
     for update skip locked
     limit p_limit
  ),
  claimed as (
    update notification_outbox o
       set status = 'processing', locked_at = p_now, locked_by = p_worker
      from due
     where o.id = due.id
    returning o.id, o.template_key, o.user_id, o.payload_json, o.retry_count, o.dedupe_key
  )
  select c.id, c.template_key, c.user_id, u.line_id, c.payload_json, c.retry_count, c.dedupe_key
    from claimed c
    left join users u on u.id = c.user_id;
end $$;

revoke all on function claim_notification_outbox(text, timestamptz, int, int) from public;
grant execute on function claim_notification_outbox(text, timestamptz, int, int) to service_role;
