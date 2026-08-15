import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import {
  createAdmin,
  listAdmins,
  setAdminDisabled,
  setAdminRole,
  resetAdminPassword,
  revokeAdminSessions,
} from '@/server/services/adminAccountService'
import type { AdminAccountListRow } from '@/server/repositories/parkingRepository'
import type { AuditActor } from '@/server/services/auditContext'

function run(over: Partial<MockRepo> = {}) {
  const repo = makeMockRepo(over)
  return { repo, r: asRepo(repo) }
}

const listRow = (over: Partial<AdminAccountListRow> = {}): AdminAccountListRow => ({
  id: '11111111-1111-4111-8111-111111111111',
  username: 'alice',
  display_name: '王姐妹',
  locked_at: null,
  disabled_at: null,
  created_at: new Date('2026-01-01T00:00:00Z'),
  role: 'superadmin',
  ...over,
})

const SELF = 'self-admin-id'
const TARGET = 'target-admin-id'
const SESSION = 'self-session-id'
const REQ = 'req-id-0001'
const NOW = new Date('2026-07-12T00:00:00Z')

// The audited surface (0030) takes a typed actor rather than a bare id, so the
// service can never be handed an admin id with no session behind it.
const ACTOR: AuditActor = {
  actorType: 'admin',
  actorId: SELF,
  actorSessionId: SESSION,
  actorRoleSnapshot: null,
}

describe('listAdmins', () => {
  it('derives active/disabled/locked status and never exposes password_hash', async () => {
    const { r } = run({
      listAdminAccounts: vi.fn(async () => [
        listRow({ id: 'a', disabled_at: null, locked_at: null }),
        listRow({ id: 'b', disabled_at: new Date('2026-01-01T00:00:00Z') }),
        listRow({ id: 'c', locked_at: new Date(NOW.getTime() - 60_000) }),       // within lock window
        listRow({ id: 'd', locked_at: new Date(NOW.getTime() - 3600_000) }),     // lock window elapsed
      ]),
    })
    const { items } = await listAdmins(r, NOW)
    expect(items.map(i => i.status)).toEqual(['active', 'disabled', 'locked', 'active'])
    expect(JSON.stringify(items)).not.toContain('password_hash')
    expect(JSON.stringify(items)).not.toContain('scrypt$')
  })
})

describe('setAdminDisabled', () => {
  // 2C-2 (rule 7): self-target is no longer short-circuited in the service — it is passed
  // to the RPC, which refuses AND audits it, so the refusal is recorded from every entry
  // point rather than only on a direct RPC call.
  it('self-target is passed to the RPC (which audits it), reason relayed', async () => {
    const setDisabled = vi.fn(async () => ({ ok: false, reason: 'cannot_target_self' }))
    const { repo, r } = run({ setAdminDisabled: setDisabled })
    const res = await setAdminDisabled({ targetId: SELF, actor: ACTOR, disabled: true, requestId: REQ }, r, NOW)
    expect(res).toEqual({ ok: false, reason: 'cannot_target_self' })
    expect(repo.setAdminDisabled).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: SELF, actingAdminId: SELF, actingSessionId: SESSION, requestId: REQ }),
    )
  })

  it('passes through not_found from the repo/RPC', async () => {
    const { r } = run({ setAdminDisabled: vi.fn(async () => ({ ok: false, reason: 'not_found' })) })
    const res = await setAdminDisabled({ targetId: TARGET, actor: ACTOR, disabled: true, requestId: REQ }, r, NOW)
    expect(res).toEqual({ ok: false, reason: 'not_found' })
  })

  // 2C-1 (#19): the guard counts SUPERADMINS, not admins — leaving a room full of
  // clerks with nobody who can manage accounts is the failure it exists to prevent.
  it('passes through last_active_superadmin from the repo/RPC', async () => {
    const { r } = run({ setAdminDisabled: vi.fn(async () => ({ ok: false, reason: 'last_active_superadmin' })) })
    const res = await setAdminDisabled({ targetId: TARGET, actor: ACTOR, disabled: true, requestId: REQ }, r, NOW)
    expect(res).toEqual({ ok: false, reason: 'last_active_superadmin' })
  })

  // Defence in depth: the route refuses a clerk first, but the RPC re-derives the role
  // in-transaction and refuses again. The service must relay that, not swallow it.
  it('passes through forbidden_role from the repo/RPC', async () => {
    const { r } = run({ setAdminDisabled: vi.fn(async () => ({ ok: false, reason: 'forbidden_role' })) })
    const res = await setAdminDisabled({ targetId: TARGET, actor: ACTOR, disabled: true, requestId: REQ }, r, NOW)
    expect(res).toEqual({ ok: false, reason: 'forbidden_role' })
  })

  it('disable success calls the repo with disabled:true and the acting admin id', async () => {
    const setDisabled = vi.fn(async () => ({ ok: true }))
    const { repo, r } = run({ setAdminDisabled: setDisabled })
    const res = await setAdminDisabled({ targetId: TARGET, actor: ACTOR, disabled: true, requestId: REQ }, r, NOW)
    expect(res).toEqual({ ok: true })
    expect(repo.setAdminDisabled).toHaveBeenCalledWith({
      targetId: TARGET, actingAdminId: SELF, actingSessionId: SESSION, requestId: REQ,
      disabled: true, nowIso: NOW.toISOString(),
    })
  })

  it('enable success calls the repo with disabled:false', async () => {
    const setDisabled = vi.fn(async () => ({ ok: true }))
    const { repo, r } = run({ setAdminDisabled: setDisabled })
    const res = await setAdminDisabled({ targetId: TARGET, actor: ACTOR, disabled: false, requestId: REQ }, r, NOW)
    expect(res).toEqual({ ok: true })
    expect(repo.setAdminDisabled).toHaveBeenCalledWith(
      expect.objectContaining({ disabled: false }),
    )
  })

  // The audit row is written by the RPC inside the business transaction, so the
  // service must never be able to report success on an actor it cannot attribute.
  // Falling back to a system/anonymous actor here would let a threading bug produce
  // a disable that the log cannot pin on anyone.
  it('refuses an actor that is not an admin with a session, without touching the repo', async () => {
    const setDisabled = vi.fn(async () => ({ ok: true }))
    const { r } = run({ setAdminDisabled: setDisabled })
    const sessionless: AuditActor = { ...ACTOR, actorSessionId: null }

    await expect(
      setAdminDisabled({ targetId: TARGET, actor: sessionless, disabled: true, requestId: REQ }, r, NOW),
    ).rejects.toThrow(/admin actor/)
    expect(setDisabled).not.toHaveBeenCalled()
  })
})

describe('resetAdminPassword', () => {
  // 2C-2 (rule 7): self-target reaches the RPC, which audits the refusal.
  it('self-target is passed to the RPC (which audits it), reason relayed', async () => {
    const reset = vi.fn(async () => ({ ok: false, reason: 'cannot_target_self' }))
    const { repo, r } = run({ resetAdminPassword: reset })
    const res = await resetAdminPassword({ targetId: SELF, actor: ACTOR, requestId: REQ }, r)
    expect(res).toEqual({ ok: false, reason: 'cannot_target_self' })
    expect(repo.resetAdminPassword).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: SELF, actingAdminId: SELF, actingSessionId: SESSION, requestId: REQ }),
    )
  })

  it('passes through not_found', async () => {
    const { r } = run({ resetAdminPassword: vi.fn(async () => ({ ok: false, reason: 'not_found' })) })
    const res = await resetAdminPassword({ targetId: TARGET, actor: ACTOR, requestId: REQ }, r)
    expect(res).toEqual({ ok: false, reason: 'not_found' })
  })

  it('success returns a fresh plaintext password and passes only its HASH to the repo', async () => {
    const reset = vi.fn(async () => ({ ok: true, username: 'alice', disabled: false }))
    const { repo, r } = run({ resetAdminPassword: reset })
    const res = await resetAdminPassword({ targetId: TARGET, actor: ACTOR, requestId: REQ }, r)
    expect(res).toMatchObject({ ok: true, username: 'alice', disabled: false })
    const password = (res as { password: string }).password
    expect(typeof password).toBe('string')
    expect(password.length).toBeGreaterThan(20)

    const arg = (repo.resetAdminPassword as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.targetId).toBe(TARGET)
    expect(arg.actingAdminId).toBe(SELF)
    expect(arg.actingSessionId).toBe(SESSION)
    expect(arg.requestId).toBe(REQ)
    expect(arg.passwordHash).toMatch(/^scrypt\$/)
    expect(arg.passwordHash).not.toBe(password)   // hash, not plaintext
  })

  it('generates a different password on each call', async () => {
    const { r } = run({ resetAdminPassword: vi.fn(async () => ({ ok: true, username: 'alice', disabled: false })) })
    const res1 = await resetAdminPassword({ targetId: TARGET, actor: ACTOR, requestId: REQ }, r)
    const res2 = await resetAdminPassword({ targetId: TARGET, actor: ACTOR, requestId: REQ }, r)
    expect((res1 as { password: string }).password).not.toBe((res2 as { password: string }).password)
  })

  it('a disabled target stays reported as disabled (reset does not re-enable)', async () => {
    const { r } = run({ resetAdminPassword: vi.fn(async () => ({ ok: true, username: 'alice', disabled: true })) })
    const res = await resetAdminPassword({ targetId: TARGET, actor: ACTOR, requestId: REQ }, r)
    expect(res).toMatchObject({ ok: true, disabled: true })
  })
})

describe('revokeAdminSessions', () => {
  // 2C-2: self-target is NO LONGER short-circuited here (rule 7) — the RPC decides and
  // audits it. The service just threads the actor and relays the reason.
  it('self-target is passed to the RPC (which audits it), reason relayed', async () => {
    const rpc = vi.fn(async () => ({ ok: false, reason: 'cannot_target_self' }))
    const { repo, r } = run({ revokeAdminSessions: rpc })
    const res = await revokeAdminSessions({ targetId: SELF, actor: ACTOR, requestId: REQ }, r)
    expect(res).toEqual({ ok: false, reason: 'cannot_target_self' })
    expect(repo.revokeAdminSessions).toHaveBeenCalledWith({
      targetId: SELF, actingAdminId: SELF, actingSessionId: SESSION, requestId: REQ,
    })
  })

  it('passes through not_found from the RPC', async () => {
    const { r } = run({ revokeAdminSessions: vi.fn(async () => ({ ok: false, reason: 'not_found' })) })
    const res = await revokeAdminSessions({ targetId: TARGET, actor: ACTOR, requestId: REQ }, r)
    expect(res).toEqual({ ok: false, reason: 'not_found' })
  })

  it('success returns the revoked count', async () => {
    const { r } = run({ revokeAdminSessions: vi.fn(async () => ({ ok: true, sessions_revoked: 2 })) })
    const res = await revokeAdminSessions({ targetId: TARGET, actor: ACTOR, requestId: REQ }, r)
    expect(res).toEqual({ ok: true, sessionsRevoked: 2 })
  })

  it('refuses a sessionless actor without touching the repo', async () => {
    const rpc = vi.fn(async () => ({ ok: true, sessions_revoked: 0 }))
    const { r } = run({ revokeAdminSessions: rpc })
    await expect(
      revokeAdminSessions({ targetId: TARGET, actor: { ...ACTOR, actorSessionId: null }, requestId: REQ }, r),
    ).rejects.toThrow(/admin actor/)
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('setAdminRole', () => {
  it('threads actor/session/requestId and the new role to the RPC', async () => {
    const rpc = vi.fn(async () => ({ ok: true, changed: true, role: 'superadmin' }))
    const { repo, r } = run({ setAdminRole: rpc })
    const res = await setAdminRole({ targetId: TARGET, role: 'superadmin', actor: ACTOR, requestId: REQ }, r)
    expect(res).toEqual({ ok: true, changed: true, role: 'superadmin' })
    expect(repo.setAdminRole).toHaveBeenCalledWith({
      targetId: TARGET, role: 'superadmin', actingAdminId: SELF, actingSessionId: SESSION, requestId: REQ,
    })
  })

  it('relays a same-role no-op as changed:false', async () => {
    const { r } = run({ setAdminRole: vi.fn(async () => ({ ok: true, changed: false, role: 'clerk' })) })
    const res = await setAdminRole({ targetId: TARGET, role: 'clerk', actor: ACTOR, requestId: REQ }, r)
    expect(res).toEqual({ ok: true, changed: false, role: 'clerk' })
  })

  it.each(['cannot_target_self', 'forbidden_role', 'last_active_superadmin', 'not_found'] as const)(
    'relays typed refusal %s',
    async reason => {
      const { r } = run({ setAdminRole: vi.fn(async () => ({ ok: false, reason })) })
      const res = await setAdminRole({ targetId: TARGET, role: 'clerk', actor: ACTOR, requestId: REQ }, r)
      expect(res).toEqual({ ok: false, reason })
    },
  )
})

describe('createAdmin', () => {
  const dbRow = {
    ok: true as const,
    id: TARGET,
    username: 'newone',
    display_name: '新同工',
    role: 'clerk',
    created_at: '2026-07-24T00:00:00Z',
    disabled_at: null,
    locked_at: null,
  }

  it('generates a one-time password, passes only its HASH, returns the canonical account', async () => {
    const rpc = vi.fn(async () => dbRow)
    const { repo, r } = run({ createAdminAccount: rpc })
    const res = await createAdmin(
      { username: 'newone', displayName: '新同工', role: 'clerk', actor: ACTOR, requestId: REQ }, r, NOW,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.account).toEqual({
      id: TARGET, username: 'newone', displayName: '新同工', role: 'clerk',
      status: 'active', createdAt: new Date('2026-07-24T00:00:00Z').toISOString(),
    })
    expect(typeof res.password).toBe('string')
    expect(res.password.length).toBeGreaterThan(20)

    const arg = (repo.createAdminAccount as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.passwordHash).toMatch(/^scrypt\$/)
    expect(arg.passwordHash).not.toBe(res.password) // hash, not plaintext
    expect(arg.actingAdminId).toBe(SELF)
    expect(arg.actingSessionId).toBe(SESSION)
    expect(arg.requestId).toBe(REQ)
  })

  it('relays username_taken', async () => {
    const { r } = run({ createAdminAccount: vi.fn(async () => ({ ok: false, reason: 'username_taken' })) })
    const res = await createAdmin(
      { username: 'dup', displayName: null, role: 'clerk', actor: ACTOR, requestId: REQ }, r, NOW,
    )
    expect(res).toEqual({ ok: false, reason: 'username_taken' })
  })

  it('generates a different password each call', async () => {
    const { r } = run({ createAdminAccount: vi.fn(async () => dbRow) })
    const a = await createAdmin({ username: 'a', displayName: null, role: 'clerk', actor: ACTOR, requestId: REQ }, r, NOW)
    const b = await createAdmin({ username: 'b', displayName: null, role: 'clerk', actor: ACTOR, requestId: REQ }, r, NOW)
    expect(a.ok && b.ok && a.password !== b.password).toBe(true)
  })
})
