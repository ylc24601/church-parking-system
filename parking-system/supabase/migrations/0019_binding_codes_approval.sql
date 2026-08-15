-- Phase 5B Slice 1: approve a captured pending binding into users.line_id.
-- 5A captured `{line_user_id, submitted_code}` (pending_binding) but nothing said WHICH member a
-- code belongs to. This slice adds `binding_codes` (a one-time code issued out-of-band to a known
-- member → user_id), plus atomic approve/reject RPCs that promote a pending claim into
-- users.line_id. DB/RPC only — no CLI, no send.
--
-- Identity = two factors: possessing the code proves the member (binding_codes.user_id); the 5A
-- webhook capture proves the LINE account (pending_binding.line_user_id). Approval is human-gated
-- at the CLI layer (Slice 2); these RPCs expose an explicit dry-run so the CLI previews the typed
-- outcome without writing.
--
-- Privacy: results are counts + typed reason codes only — never line_user_id, submitted_code, or
-- raw provider data.

-- ── binding_codes ─────────────────────────────────────────────────────────────────────────────
create table binding_codes (
  id                          uuid primary key default gen_random_uuid(),
  code                        text        not null,                      -- normalized (trim+upper), same format as capture
  user_id                     uuid        not null references users(id),
  expires_at                  timestamptz not null,
  consumed_at                 timestamptz,                                -- set when an approval consumes it
  consumed_pending_binding_id uuid        references pending_binding(id), -- audit link to the claim that consumed it
  consumed_line_user_id       text,                                       -- which LINE account consumed it
  created_at                  timestamptz not null default now(),
  created_by                  text,                                       -- optional operator marker
  note                        text,                                       -- optional
  constraint binding_codes_code_format check (code ~ '^[A-Z0-9-]{4,16}$')
);

create unique index binding_codes_code_key on binding_codes (code);

-- binding_codes is created AFTER 0004's one-time blanket grant → set privileges explicitly here.
alter table binding_codes enable row level security;
revoke all on binding_codes from anon, authenticated;
grant select, insert, update, delete on binding_codes to service_role;

-- ── pending_binding: minimal audit columns for approve/reject ───────────────────────────────────
alter table pending_binding
  add column approved_at      timestamptz,
  add column approved_user_id uuid references users(id),
  add column rejected_at      timestamptz,
  add column rejected_reason  text;

-- ── approve_pending_binding — atomic, typed, dry-run aware ───────────────────────────────────────
-- Reads the pending row BY ID internally (raw line_user_id / submitted_code never cross the API
-- surface). Guards run in a fixed precedence and return a typed reason instead of throwing:
--   pending_not_found → pending_not_pending → code_not_found → code_expired → code_consumed →
--   member_already_bound → line_id_taken → approved.
-- p_dry_run=true evaluates all guards and returns `would_approve` WITHOUT writing. p_dry_run=false
-- writes: users.line_id (guarded on line_id is null), consume the code, mark pending approved.
create or replace function approve_pending_binding(
  p_pending_id uuid,
  p_now        timestamptz,
  p_dry_run    boolean
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_pending  pending_binding%rowtype;
  v_code     binding_codes%rowtype;
  v_existing text;
  v_updated  int;
begin
  select * into v_pending from pending_binding where id = p_pending_id;
  if not found then
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'pending_not_found');
  end if;

  if v_pending.status <> 'pending' then
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'pending_not_pending');
  end if;

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

  select line_id into v_existing from users where id = v_code.user_id;
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
     where id = v_code.user_id and line_id is null;
    get diagnostics v_updated = row_count;
  exception when unique_violation then
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'line_id_taken');
  end;
  if v_updated = 0 then
    -- Raced: member got bound between the guard and this write.
    return jsonb_build_object('approved', 0, 'would_approve', false, 'reason', 'member_already_bound');
  end if;

  update binding_codes set
    consumed_at                 = p_now,
    consumed_pending_binding_id = v_pending.id,
    consumed_line_user_id       = v_pending.line_user_id
   where id = v_code.id;

  update pending_binding set
    status           = 'approved',
    approved_at      = p_now,
    approved_user_id = v_code.user_id
   where id = v_pending.id;

  return jsonb_build_object('approved', 1, 'would_approve', true, 'reason', 'approved');
end $$;

revoke all on function approve_pending_binding(uuid, timestamptz, boolean) from public;
grant execute on function approve_pending_binding(uuid, timestamptz, boolean) to service_role;

-- ── reject_pending_binding — mark a pending claim rejected (audit) ───────────────────────────────
-- p_reason is an operator-supplied classification (e.g. 'duplicate', 'unrecognized'); callers must
-- not pass line_user_id / code into it.
create or replace function reject_pending_binding(
  p_pending_id uuid,
  p_reason     text,
  p_now        timestamptz
) returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare v_status text;
begin
  select status into v_status from pending_binding where id = p_pending_id;
  if not found then
    return jsonb_build_object('rejected', 0, 'reason', 'pending_not_found');
  end if;
  if v_status <> 'pending' then
    return jsonb_build_object('rejected', 0, 'reason', 'pending_not_pending');
  end if;

  update pending_binding set
    status          = 'rejected',
    rejected_at     = p_now,
    rejected_reason = p_reason
   where id = p_pending_id;

  return jsonb_build_object('rejected', 1, 'reason', 'rejected');
end $$;

revoke all on function reject_pending_binding(uuid, text, timestamptz) from public;
grant execute on function reject_pending_binding(uuid, text, timestamptz) to service_role;
