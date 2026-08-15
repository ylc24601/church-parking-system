import { randomBytes } from 'node:crypto'
import type { AdminRole } from '@/lib/adminRoles'
import { ADMIN_LOGIN_LOCK_MINUTES } from '@/lib/allocation/rules'
import { hashPin } from '@/server/http/pinHash'
import { createParkingRepository, type ParkingRepository } from '@/server/repositories/parkingRepository'
import { requireAdminActor, type AuditActor } from '@/server/services/auditContext'

// ── Admin account management (Phase 8 Slice 3, roles in Wave 2C) ─────────────
// Every state-changing action here targets an OTHER admin. Wave 2C-2 (#19) moved the
// self-target check ENTIRELY into the RPC: it is an audited governance refusal, and a
// service-layer short-circuit would make the same refusal audited (direct RPC) or not
// (app path) depending on entry point. So this layer no longer compares targetId to the
// acting id — it threads the actor and lets the DB decide and record.
//
// Each operation wraps a single atomic RPC (0026/0035/0036) that writes its audit row
// inside the transaction — see those migrations for why a sequence of separate calls is
// unsafe here (partial failure = live credential/session inconsistency). This layer must
// not build metadata, must not write a second row, and must not report success on an
// actor it cannot attribute.
//
// The whole surface is superadmin-only. The routes refuse a clerk before reaching here,
// and the RPCs refuse one again inside the transaction from the role they read
// themselves — a role is never taken on the caller's word.

export type AdminAccountActionReason =
  | 'not_found'
  | 'cannot_target_self'
  // The invariant: at least one enabled superadmin must remain. Unreachable through
  // today's RPCs — the actor must itself be an active superadmin and cannot target
  // itself, so one always survives (see 0035's comment on the guard). Kept in the
  // union so a future path that CAN shrink the set does not land on an unmapped
  // reason and 500.
  | 'last_active_superadmin'
  // Race guards between the auth check and the transaction (adminAuth deletes a
  // disabled account's session on every request, so neither should be reachable).
  | 'forbidden_role'
  | 'acting_admin_disabled'
  | 'acting_admin_not_found'
  // create only: the username unique index rejected it (0036 maps only that constraint).
  | 'username_taken'

export type AdminAccountActionResult =
  | { ok: true }
  | { ok: false; reason: AdminAccountActionReason }

// One HTTP mapping for the whole surface, so the operations cannot drift apart. The
// race guards collapse to 403 on the wire (all "you may not, as you are"); the
// distinction survives in the RPC's return value and the audit row. username_taken is a
// 409 conflict; last_active_superadmin likewise.
export const ADMIN_ACCOUNT_ACTION_STATUS: Record<AdminAccountActionReason, number> = {
  not_found: 404,
  cannot_target_self: 403,
  forbidden_role: 403,
  acting_admin_disabled: 403,
  acting_admin_not_found: 403,
  last_active_superadmin: 409,
  username_taken: 409,
}

export interface AdminAccountListItem {
  id: string
  username: string
  displayName: string | null
  status: 'active' | 'disabled' | 'locked'
  createdAt: string
  role: AdminRole
}

export async function listAdmins(
  repo: ParkingRepository = createParkingRepository(),
  now: Date = new Date(),
): Promise<{ items: AdminAccountListItem[] }> {
  const rows = await repo.listAdminAccounts()
  const items = rows.map(row => ({
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    status: deriveStatus(row.disabled_at, row.locked_at, now),
    createdAt: row.created_at.toISOString(),
    role: row.role,
  }))
  return { items }
}

function deriveStatus(
  disabledAt: Date | null,
  lockedAt: Date | null,
  now: Date,
): 'active' | 'disabled' | 'locked' {
  if (disabledAt !== null) return 'disabled'
  if (lockedAt !== null && now.getTime() < lockedAt.getTime() + ADMIN_LOGIN_LOCK_MINUTES * 60_000) {
    return 'locked'
  }
  return 'active'
}

// Audited (0030). The actor and requestId are passed straight through to the RPC,
// which writes the audit row in the same transaction — this service must not build
// metadata, must not write a second row, and must not catch an audit failure and
// report success: an audit failure means the disable did not happen.
export async function setAdminDisabled(
  params: { targetId: string; actor: AuditActor; disabled: boolean; requestId: string },
  repo: ParkingRepository = createParkingRepository(),
  now: Date = new Date(),
): Promise<AdminAccountActionResult> {
  // No self-target short-circuit (rule 7, 2C-2): the RPC decides and audits it, so the
  // refusal is recorded whatever the entry point. requireAdminActor still throws on a
  // malformed actor — that is a threading bug, not a user action.
  const { adminId, sessionId } = requireAdminActor(params.actor)
  const result = await repo.setAdminDisabled({
    targetId: params.targetId,
    actingAdminId: adminId,
    actingSessionId: sessionId,
    disabled: params.disabled,
    nowIso: now.toISOString(),
    requestId: params.requestId,
  })
  if (!result.ok) {
    return { ok: false, reason: (result.reason ?? 'not_found') as AdminAccountActionReason }
  }
  return { ok: true }
}

export type ResetAdminPasswordResult =
  | { ok: true; username: string; password: string; disabled: boolean }
  | { ok: false; reason: AdminAccountActionReason }

// Generates a fresh one-time password (same shape as scripts/run-admin-create.ts:
// 18 random bytes, base64url → 24 chars, ~144 bits), hashes it, and hands the hash
// (never the plaintext) to the atomic reset RPC. The plaintext only ever exists in
// this function's local scope and the ok:true return value — it is not logged and
// does not reach the repository/RPC layer.
//
// Audited since 0035, on the same terms as setAdminDisabled: the row is written inside
// the RPC's transaction, so this must not build metadata and must not report success
// if the audit write failed.
export async function resetAdminPassword(
  params: { targetId: string; actor: AuditActor; requestId: string },
  repo: ParkingRepository = createParkingRepository(),
): Promise<ResetAdminPasswordResult> {
  const { adminId, sessionId } = requireAdminActor(params.actor) // self-target: RPC audits it (rule 7)
  const password = randomBytes(18).toString('base64url')
  const result = await repo.resetAdminPassword({
    targetId: params.targetId,
    actingAdminId: adminId,
    actingSessionId: sessionId,
    passwordHash: hashPin(password),
    requestId: params.requestId,
  })
  if (!result.ok) {
    return { ok: false, reason: (result.reason ?? 'not_found') as AdminAccountActionReason }
  }
  return { ok: true, username: result.username!, password, disabled: result.disabled! }
}

export type RevokeSessionsResult =
  | { ok: true; sessionsRevoked: number }
  | { ok: false; reason: AdminAccountActionReason }

// Wave 2C-2 (#19): now an audited RPC (0036) rather than a bare repository DELETE, so
// forcing an operator out leaves a trail like every other account action. Same actor
// contract as setAdminDisabled; self-target and role are decided/recorded in the RPC.
export async function revokeAdminSessions(
  params: { targetId: string; actor: AuditActor; requestId: string },
  repo: ParkingRepository = createParkingRepository(),
): Promise<RevokeSessionsResult> {
  const { adminId, sessionId } = requireAdminActor(params.actor)
  const result = await repo.revokeAdminSessions({
    targetId: params.targetId,
    actingAdminId: adminId,
    actingSessionId: sessionId,
    requestId: params.requestId,
  })
  if (!result.ok) {
    return { ok: false, reason: (result.reason ?? 'not_found') as AdminAccountActionReason }
  }
  return { ok: true, sessionsRevoked: result.sessions_revoked ?? 0 }
}

export type CreateAdminResult =
  | { ok: true; account: AdminAccountListItem; password: string }
  | { ok: false; reason: AdminAccountActionReason }

// Generates the one-time password (same shape as resetAdminPassword), hashes it, and
// hands only the hash to the RPC. The plaintext exists solely in this scope and the
// ok:true return — never logged, never in the RPC or audit. The returned account is the
// DB-canonical row (normalized username/display_name), so the caller never reinterprets
// input.
export async function createAdmin(
  params: { username: string; displayName: string | null; role: AdminRole; actor: AuditActor; requestId: string },
  repo: ParkingRepository = createParkingRepository(),
  now: Date = new Date(),
): Promise<CreateAdminResult> {
  const { adminId, sessionId } = requireAdminActor(params.actor)
  const password = randomBytes(18).toString('base64url')
  const result = await repo.createAdminAccount({
    username: params.username,
    passwordHash: hashPin(password),
    displayName: params.displayName,
    role: params.role,
    actingAdminId: adminId,
    actingSessionId: sessionId,
    requestId: params.requestId,
  })
  if (!result.ok) {
    return { ok: false, reason: (result.reason ?? 'username_taken') as AdminAccountActionReason }
  }
  return {
    ok: true,
    password,
    account: {
      id: result.id!,
      username: result.username!,
      displayName: result.display_name ?? null,
      role: (result.role ?? params.role) as AdminRole,
      status: deriveStatus(
        result.disabled_at ? new Date(result.disabled_at) : null,
        result.locked_at ? new Date(result.locked_at) : null,
        now,
      ),
      createdAt: new Date(result.created_at!).toISOString(),
    },
  }
}

export type SetAdminRoleResult =
  | { ok: true; changed: boolean; role: AdminRole }
  | { ok: false; reason: AdminAccountActionReason }

export async function setAdminRole(
  params: { targetId: string; role: AdminRole; actor: AuditActor; requestId: string },
  repo: ParkingRepository = createParkingRepository(),
): Promise<SetAdminRoleResult> {
  const { adminId, sessionId } = requireAdminActor(params.actor)
  const result = await repo.setAdminRole({
    targetId: params.targetId,
    role: params.role,
    actingAdminId: adminId,
    actingSessionId: sessionId,
    requestId: params.requestId,
  })
  if (!result.ok) {
    return { ok: false, reason: (result.reason ?? 'not_found') as AdminAccountActionReason }
  }
  return { ok: true, changed: result.changed ?? true, role: (result.role ?? params.role) as AdminRole }
}
