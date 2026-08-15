-- Phase 7 Slice 1: member LIFF login sessions.
-- A member opens the LIFF page, the server verifies the LIFF ID token against LINE's
-- verify endpoint, resolves users.line_id, and creates a session row here. The cookie
-- carries a raw random token; only its sha256 hex lands in token_hash — a DB leak alone
-- must not yield usable sessions (unlike staff_sessions, whose cookie stores the row id;
-- upgrading staff to hashed tokens is a separate backlog item).
--
-- Multi-session policy: one row per login, several devices may coexist per member.
-- Logout deletes only its own row; expired rows are lazily deleted at the owner's next
-- login. No revoke-all in v1.

create table member_sessions (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references users(id) on delete cascade,
  token_hash text        not null unique,   -- sha256 hex of the cookie token; raw token is never stored
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  -- Guards seeds / future CLI-admin writes / clock-math regressions from minting a
  -- session that is already expired at creation.
  constraint member_sessions_expiry_after_creation check (expires_at > created_at)
);

-- Lazy cleanup of a member's expired sessions happens at login.
create index member_sessions_user_idx on member_sessions (user_id);

-- member_sessions is created AFTER 0004's one-time blanket grant, so privileges must be
-- set explicitly here. RLS deny-all + service_role (which bypasses RLS) is the only
-- DB principal; authorization happens in the app layer.
alter table member_sessions enable row level security;
revoke all on member_sessions from anon, authenticated;
grant select, insert, update, delete on member_sessions to service_role;
