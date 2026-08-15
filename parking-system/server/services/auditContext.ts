import { randomUUID } from 'node:crypto'
import type { AdminSession } from '@/server/http/adminAuth'
import type { MemberSession } from '@/server/http/memberAuth'
import type { StaffSession } from '@/server/http/staffAuth'

// ── Audit actor contract (Wave 2A-1 / #15) ───────────────────────────────────
// The typed identity an audited mutation carries from the auth layer down to the
// DB RPC, which writes the audit row INSIDE the business transaction (migration
// 0030). Nothing here writes to the log: there is deliberately no "write an audit
// row" function in the app at all. The only writer is private.append_audit_log,
// which the application principal cannot execute — so a second, non-atomic
// `repo.update(); repo.writeAudit()` pattern is not merely discouraged here, it is
// unavailable. Audit failure rolls the business change back with it.
//
// Actor kinds mirror the audit_actor_type enum and audit_logs_actor_shape_ck.
// Only `admin` is exercised in 2A-1; the rest are the contract #10/#14A and later
// slices build on.

export type AuditActorType = 'admin' | 'staff_session' | 'member' | 'job' | 'system'

export interface AuditActor {
  actorType: AuditActorType
  actorId: string | null
  actorSessionId: string | null
  // The actor's role AS OF this action — and the app deliberately never fills it.
  // Wave 2C-1 (#19) resolves the role inside the business transaction instead: the
  // role-sensitive RPCs lock and read the acting account, authorise on that value and
  // pass the same one to the audit writer, while private.append_audit_log resolves it
  // for the RPCs that predate roles. That is still as-of-action (the hazard the
  // original design warned about was re-reading today's role at DISPLAY time), and it
  // means a role asserted over HTTP can never reach the log. See 0035's header.
  actorRoleSnapshot: string | null
}

// A per-mutation correlation id, generated at the route and threaded
// route -> service -> repository -> RPC -> audit row. audit_logs.request_id is
// NOT NULL, so a path that forgets to thread it fails loudly rather than quietly
// writing an untraceable row. It also lets server logs point at an operation
// without carrying any PII.
export function newRequestId(): string {
  return randomUUID()
}

// An admin acting through a known session. Username is deliberately NOT carried:
// it is mutable, so a snapshot of it would rot, and the log stores IDs and
// resolves them for display instead.
export function adminActor(session: AdminSession): AuditActor {
  // Fails closed. A missing actor on an action that requires one is a threading
  // bug, and the tempting "fall back to system" would bury it in the very record
  // meant to expose it — the audit row would claim the system did something a
  // person did.
  if (!session.adminId || !session.sessionId) {
    throw new Error('auditContext: admin actor requires both adminId and sessionId')
  }
  return {
    actorType: 'admin',
    actorId: session.adminId,
    actorSessionId: session.sessionId,
    actorRoleSnapshot: null,
  }
}

// Narrows an actor to "an admin acting through a session". The constructors above
// already guarantee this, so this is the same belt-and-braces the RPCs use (0026
// re-checks self-target inside the transaction "so no future caller can bypass it"):
// an AuditActor is a plain object a future caller could hand-build, and an
// admin-only mutation should not take one on trust.
//
// It returns both ids rather than just the adminId so callers inherit the non-null
// guarantee in the type and never need a `!` to pass the session on.
export function requireAdminActor(actor: AuditActor): { adminId: string; sessionId: string } {
  if (actor.actorType !== 'admin' || !actor.actorId || !actor.actorSessionId) {
    throw new Error(`auditContext: expected an admin actor with a session, got ${actor.actorType}`)
  }
  return { adminId: actor.actorId, sessionId: actor.actorSessionId }
}

export function memberActor(session: MemberSession): AuditActor {
  if (!session.userId || !session.sessionId) {
    throw new Error('auditContext: member actor requires both userId and sessionId')
  }
  return {
    actorType: 'member',
    actorId: session.userId,
    actorSessionId: session.sessionId,
    actorRoleSnapshot: null,
  }
}

// A staff PIN session is a SHARED per-event credential: every on-site device that
// typed this week's PIN holds the same staff_sessions row. It identifies the
// session, never a natural person — so there is no actorSessionId to distinguish
// (the actor IS the session), and any UI must say「現場同工 session …」rather than
// inventing a name. Attributing a staff action to an individual is not possible
// with the current credential model, and the audit log must not pretend otherwise.
export function staffSessionActor(session: StaffSession): AuditActor {
  if (!session.sessionId) {
    throw new Error('auditContext: staff actor requires sessionId')
  }
  return {
    actorType: 'staff_session',
    actorId: session.sessionId,
    actorSessionId: null,
    actorRoleSnapshot: null,
  }
}
