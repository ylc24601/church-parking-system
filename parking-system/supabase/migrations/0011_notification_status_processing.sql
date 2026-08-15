-- Phase 4 Slice A — notification dispatcher: add a 'processing' state to the
-- notification lifecycle so a due row can be atomically CLAIMED (leased) before the
-- external LINE call, closing the concurrent-dispatcher double-push window.
--
-- This is split from the lease columns + claim RPC (0012) on purpose: a newly added
-- enum value cannot be REFERENCED in the same transaction that adds it, and Supabase
-- runs each migration file in its own transaction. 0012 (separate txn) uses it.
alter type notification_status add value if not exists 'processing';
