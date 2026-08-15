import { describe, expect, it } from 'vitest'
import {
  adminActor,
  memberActor,
  newRequestId,
  requireAdminActor,
  staffSessionActor,
  type AuditActor,
} from '@/server/services/auditContext'

// Wave 2A-1 (#15). These constructors are the only place an actor identity enters
// the audit chain, so the properties worth pinning are the ones that would let a
// wrong or unattributable row be written: failing closed, and never storing a
// mutable or shared identifier as though it named a person.

const ADMIN = { sessionId: 'sess-1', adminId: 'admin-1', username: 'alice', role: 'superadmin' as const }

describe('adminActor', () => {
  it('carries the admin id and session id, and never the username', () => {
    const actor = adminActor(ADMIN)
    expect(actor).toEqual({
      actorType: 'admin',
      actorId: 'admin-1',
      actorSessionId: 'sess-1',
      // Still null after #19, and deliberately so: the role snapshot is resolved
      // inside the business transaction (0035), never asserted over HTTP. A session
      // role that reached the log here could be stale or forged.
      actorRoleSnapshot: null,
    })
    // Usernames are mutable, so a snapshot of one would rot; the log stores the id
    // and resolves a display name at read time instead.
    expect(JSON.stringify(actor)).not.toContain('alice')
    // Same reasoning applies to the role: it must not ride along on the actor.
    expect(JSON.stringify(actor)).not.toContain('superadmin')
  })

  it('throws rather than emitting an unattributable actor', () => {
    // Falling back to a system/anonymous actor here would be the worst outcome: the
    // audit row would claim the system did something a person did, hiding a
    // threading bug inside the record meant to expose it.
    expect(() => adminActor({ ...ADMIN, adminId: '' })).toThrow(/admin actor/)
    expect(() => adminActor({ ...ADMIN, sessionId: '' })).toThrow(/admin actor/)
  })
})

describe('requireAdminActor', () => {
  it('returns both ids for a well-formed admin actor', () => {
    expect(requireAdminActor(adminActor(ADMIN))).toEqual({ adminId: 'admin-1', sessionId: 'sess-1' })
  })

  it('rejects a hand-built actor that is not an admin with a session', () => {
    // An AuditActor is a plain object, so an admin-only mutation must not take one
    // on trust — the same belt-and-braces the RPCs apply inside the transaction.
    const staff: AuditActor = staffSessionActor({ sessionId: 'staff-sess', eventId: 'e1' })
    expect(() => requireAdminActor(staff)).toThrow(/expected an admin actor/)
    expect(() => requireAdminActor({ ...adminActor(ADMIN), actorSessionId: null })).toThrow(
      /expected an admin actor/,
    )
  })
})

describe('staffSessionActor', () => {
  it('names the shared session, not a person', () => {
    const actor = staffSessionActor({ sessionId: 'staff-sess', eventId: 'e1' })
    // The staff credential is a per-event PIN every on-site device shares, so the
    // session IS the actor: there is no individual behind it to record, and
    // actorSessionId stays null to match audit_logs_actor_shape_ck.
    expect(actor).toEqual({
      actorType: 'staff_session',
      actorId: 'staff-sess',
      actorSessionId: null,
      actorRoleSnapshot: null,
    })
  })
})

describe('memberActor', () => {
  it('carries the user id and session id', () => {
    expect(memberActor({ sessionId: 'm-sess', userId: 'user-1' })).toEqual({
      actorType: 'member',
      actorId: 'user-1',
      actorSessionId: 'm-sess',
      actorRoleSnapshot: null,
    })
  })

  it('throws rather than emitting an unattributable actor', () => {
    expect(() => memberActor({ sessionId: '', userId: 'user-1' })).toThrow(/member actor/)
  })
})

describe('newRequestId', () => {
  it('is unique per call', () => {
    // audit_logs.request_id is NOT NULL and correlates the rows one operation wrote;
    // a reused value would silently merge two unrelated operations in the viewer.
    const ids = new Set(Array.from({ length: 50 }, () => newRequestId()))
    expect(ids.size).toBe(50)
  })
})
