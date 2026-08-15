import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@/server/services/adminAccountService', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/services/adminAccountService')>()
  return {
    ...actual,
    setAdminDisabled: vi.fn(), resetAdminPassword: vi.fn(), revokeAdminSessions: vi.fn(),
    createAdmin: vi.fn(), setAdminRole: vi.fn(),
  }
})
vi.mock('@/server/http/adminAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/adminAuth')>()
  return { ...actual, getAdminSession: vi.fn() }
})

import { POST as disablePOST } from '@/app/api/admin/accounts/disable/route'
import { POST as resetPOST } from '@/app/api/admin/accounts/reset-password/route'
import { POST as revokePOST } from '@/app/api/admin/accounts/revoke-sessions/route'
import { POST as createPOST } from '@/app/api/admin/accounts/create/route'
import { POST as rolePOST } from '@/app/api/admin/accounts/role/route'
import {
  setAdminDisabled,
  resetAdminPassword,
  revokeAdminSessions,
  createAdmin,
  setAdminRole,
} from '@/server/services/adminAccountService'
import { getAdminSession } from '@/server/http/adminAuth'

const SESSION = { sessionId: 's1', adminId: 'admin-1', username: 'alice', role: 'superadmin' as const }
const CLERK_SESSION = { ...SESSION, role: 'clerk' as const }
const TARGET_ID = 'a1b2c3d4-1111-4222-8333-000000000001'

type Handler = typeof disablePOST

const post = (handler: Handler, path: string, body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request(`http://localhost/api/admin/accounts/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

describe('POST /api/admin/accounts/disable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    ;(setAdminDisabled as Mock).mockResolvedValue({ ok: true })
  })

  it('no session → 401, service never called', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    const res = await post(disablePOST, 'disable', { targetId: TARGET_ID, disabled: true })
    expect(res.status).toBe(401)
    expect(setAdminDisabled).not.toHaveBeenCalled()
  })

  it('415 non-JSON / 413 oversized / 400 malformed / 403 foreign Origin', async () => {
    const nonJson = await disablePOST(new Request('http://localhost/api/admin/accounts/disable', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x',
    }))
    expect(nonJson.status).toBe(415)
    expect((await post(disablePOST, 'disable', { targetId: TARGET_ID, disabled: true, note: 'x'.repeat(5000) })).status).toBe(413)
    expect((await post(disablePOST, 'disable', 'not-json{')).status).toBe(400)
    expect((await post(disablePOST, 'disable', { targetId: TARGET_ID, disabled: true }, { origin: 'https://evil.example' })).status).toBe(403)
  })

  it.each([
    ['non-UUID targetId', { targetId: 'not-a-uuid', disabled: true }],
    ['missing targetId', { disabled: true }],
    ['non-boolean disabled', { targetId: TARGET_ID, disabled: 'true' }],
    ['missing disabled', { targetId: TARGET_ID }],
  ])('invalid request (%s) → 400', async (_n, body) => {
    expect((await post(disablePOST, 'disable', body)).status).toBe(400)
    expect(setAdminDisabled).not.toHaveBeenCalled()
  })

  it('success → 200 { ok: true }, no-store', async () => {
    const res = await post(disablePOST, 'disable', { targetId: TARGET_ID, disabled: true })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true })
  })

  it('the audit actor is ALWAYS built from the session; a smuggled body value is ignored', async () => {
    await post(disablePOST, 'disable', { targetId: TARGET_ID, disabled: true, actingAdminId: 'attacker' })
    // Same guarantee as before 0030 — the acting identity comes from the session and
    // nowhere else — now stated against the actor the audit row is written from. If
    // a body value could reach this, an admin could pin their action on someone else.
    expect(setAdminDisabled).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: TARGET_ID,
        disabled: true,
        actor: { actorType: 'admin', actorId: 'admin-1', actorSessionId: 's1', actorRoleSnapshot: null },
      }),
    )
    const { actor, requestId } = (setAdminDisabled as Mock).mock.calls[0][0]
    expect(JSON.stringify(actor)).not.toContain('attacker')
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)   // generated per request, never from the body
  })

  it.each([
    ['cannot_target_self', 403],
    ['last_active_superadmin', 409],
    ['forbidden_role', 403],
    ['acting_admin_disabled', 403],
    ['acting_admin_not_found', 403],
    ['not_found', 404],
  ] as const)('typed %s → %i', async (reason, status) => {
    ;(setAdminDisabled as Mock).mockResolvedValue({ ok: false, reason })
    const res = await post(disablePOST, 'disable', { targetId: TARGET_ID, disabled: true })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ ok: false, reason })
  })

  it('service throw → 500 generic', async () => {
    ;(setAdminDisabled as Mock).mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(disablePOST, 'disable', { targetId: TARGET_ID, disabled: true })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'internal' })
    spy.mockRestore()
  })
})

describe('POST /api/admin/accounts/reset-password', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    ;(resetAdminPassword as Mock).mockResolvedValue({ ok: true, username: 'bob', password: 'S3cret-One-Time-Pw', disabled: false })
  })

  it('no session → 401', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    expect((await post(resetPOST, 'reset-password', { targetId: TARGET_ID })).status).toBe(401)
    expect(resetAdminPassword).not.toHaveBeenCalled()
  })

  it('non-UUID targetId → 400', async () => {
    for (const bad of [undefined, 42, 'abc', `${TARGET_ID}x`]) {
      expect((await post(resetPOST, 'reset-password', { targetId: bad })).status).toBe(400)
    }
    expect(resetAdminPassword).not.toHaveBeenCalled()
  })

  it('the audit actor is ALWAYS built from the session; smuggled body fields (username/passwordHash) are ignored', async () => {
    await post(resetPOST, 'reset-password', {
      targetId: TARGET_ID, actingAdminId: 'attacker', username: 'attacker', passwordHash: 'scrypt$fake$fake',
    })
    expect(resetAdminPassword).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: TARGET_ID,
        actor: { actorType: 'admin', actorId: 'admin-1', actorSessionId: 's1', actorRoleSnapshot: null },
      }),
    )
    const { actor, requestId } = (resetAdminPassword as Mock).mock.calls[0][0]
    expect(JSON.stringify(actor)).not.toContain('attacker')
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('success → 200 with the full password, no-store; the password is never logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(resetPOST, 'reset-password', { targetId: TARGET_ID })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true, username: 'bob', password: 'S3cret-One-Time-Pw', disabled: false })
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('S3cret-One-Time-Pw')
    spy.mockRestore()
  })

  it.each([
    ['cannot_target_self', 403],
    ['forbidden_role', 403],
    ['not_found', 404],
  ] as const)('typed %s → %i', async (reason, status) => {
    ;(resetAdminPassword as Mock).mockResolvedValue({ ok: false, reason })
    const res = await post(resetPOST, 'reset-password', { targetId: TARGET_ID })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ ok: false, reason })
  })

  it('service throw → 500 generic, no plaintext leaked in the log', async () => {
    ;(resetAdminPassword as Mock).mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(resetPOST, 'reset-password', { targetId: TARGET_ID })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'internal' })
    spy.mockRestore()
  })
})

describe('POST /api/admin/accounts/revoke-sessions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    ;(revokeAdminSessions as Mock).mockResolvedValue({ ok: true, sessionsRevoked: 2 })
  })

  it('no session → 401', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    expect((await post(revokePOST, 'revoke-sessions', { targetId: TARGET_ID })).status).toBe(401)
    expect(revokeAdminSessions).not.toHaveBeenCalled()
  })

  it('non-UUID targetId → 400', async () => {
    expect((await post(revokePOST, 'revoke-sessions', { targetId: 'nope' })).status).toBe(400)
    expect(revokeAdminSessions).not.toHaveBeenCalled()
  })

  it('the audit actor is ALWAYS built from the session; a smuggled body value is ignored', async () => {
    await post(revokePOST, 'revoke-sessions', { targetId: TARGET_ID, actingAdminId: 'attacker' })
    expect(revokeAdminSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: TARGET_ID,
        actor: { actorType: 'admin', actorId: 'admin-1', actorSessionId: 's1', actorRoleSnapshot: null },
      }),
    )
    const { actor } = (revokeAdminSessions as Mock).mock.calls[0][0]
    expect(JSON.stringify(actor)).not.toContain('attacker')
  })

  it('success → 200 with the revoked count, no-store', async () => {
    const res = await post(revokePOST, 'revoke-sessions', { targetId: TARGET_ID })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true, sessionsRevoked: 2 })
  })

  it.each([
    ['cannot_target_self', 403],
    ['forbidden_role', 403],
    ['not_found', 404],
  ] as const)('typed %s → %i', async (reason, status) => {
    ;(revokeAdminSessions as Mock).mockResolvedValue({ ok: false, reason })
    const res = await post(revokePOST, 'revoke-sessions', { targetId: TARGET_ID })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ ok: false, reason })
  })

  it('service throw → 500 generic', async () => {
    ;(revokeAdminSessions as Mock).mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(revokePOST, 'revoke-sessions', { targetId: TARGET_ID })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'internal' })
    spy.mockRestore()
  })
})

describe('POST /api/admin/accounts/create', () => {
  const OK_ACCOUNT = {
    id: TARGET_ID, username: 'newone', displayName: null, status: 'active', role: 'clerk', createdAt: '2026-07-24',
  }
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    ;(createAdmin as Mock).mockResolvedValue({ ok: true, account: OK_ACCOUNT, password: 'One-Time-Pw-123456' })
  })

  it('no session → 401', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    expect((await post(createPOST, 'create', { username: 'newone', role: 'clerk' })).status).toBe(401)
    expect(createAdmin).not.toHaveBeenCalled()
  })

  it.each([
    ['missing role', { username: 'newone' }],
    ['invalid role', { username: 'newone', role: 'root' }],
    ['bad username', { username: 'A', role: 'clerk' }],
    ['non-string username', { username: 42, role: 'clerk' }],
  ])('invalid request (%s) → 400, service never called', async (_n, body) => {
    expect((await post(createPOST, 'create', body)).status).toBe(400)
    expect(createAdmin).not.toHaveBeenCalled()
  })

  it('normalizes username + threads a session actor; the role is validated, not cast', async () => {
    await post(createPOST, 'create', { username: '  NewOne  ', displayName: ' 王 ', role: 'clerk' })
    expect(createAdmin).toHaveBeenCalledWith(
      expect.objectContaining({
        username: 'newone', displayName: '王', role: 'clerk',
        actor: { actorType: 'admin', actorId: 'admin-1', actorSessionId: 's1', actorRoleSnapshot: null },
      }),
    )
  })

  it('success → 200 with account + one-time password, no-store', async () => {
    const res = await post(createPOST, 'create', { username: 'newone', role: 'clerk' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true, account: OK_ACCOUNT, password: 'One-Time-Pw-123456' })
  })

  it('username_taken → 409', async () => {
    ;(createAdmin as Mock).mockResolvedValue({ ok: false, reason: 'username_taken' })
    const res = await post(createPOST, 'create', { username: 'dup', role: 'clerk' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, reason: 'username_taken' })
  })

  it('service throw → 500, and the one-time password never reaches the log', async () => {
    ;(createAdmin as Mock).mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(createPOST, 'create', { username: 'newone', role: 'clerk' })
    expect(res.status).toBe(500)
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('One-Time-Pw')
    spy.mockRestore()
  })
})

describe('POST /api/admin/accounts/role', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    ;(setAdminRole as Mock).mockResolvedValue({ ok: true, changed: true, role: 'superadmin' })
  })

  it('no session → 401', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    expect((await post(rolePOST, 'role', { targetId: TARGET_ID, role: 'clerk' })).status).toBe(401)
    expect(setAdminRole).not.toHaveBeenCalled()
  })

  it.each([
    ['bad targetId', { targetId: 'nope', role: 'clerk' }],
    ['missing role', { targetId: TARGET_ID }],
    ['invalid role', { targetId: TARGET_ID, role: 'root' }],
  ])('invalid request (%s) → 400', async (_n, body) => {
    expect((await post(rolePOST, 'role', body)).status).toBe(400)
    expect(setAdminRole).not.toHaveBeenCalled()
  })

  it('threads a session actor and returns changed + role, no-store', async () => {
    const res = await post(rolePOST, 'role', { targetId: TARGET_ID, role: 'superadmin', actingAdminId: 'attacker' })
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true, changed: true, role: 'superadmin' })
    expect(setAdminRole).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId: TARGET_ID, role: 'superadmin',
        actor: { actorType: 'admin', actorId: 'admin-1', actorSessionId: 's1', actorRoleSnapshot: null },
      }),
    )
  })

  it.each([
    ['cannot_target_self', 403],
    ['forbidden_role', 403],
    ['last_active_superadmin', 409],
    ['not_found', 404],
  ] as const)('typed %s → %i', async (reason, status) => {
    ;(setAdminRole as Mock).mockResolvedValue({ ok: false, reason })
    const res = await post(rolePOST, 'role', { targetId: TARGET_ID, role: 'clerk' })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ ok: false, reason })
  })
})

// ── Wave 2C-1 (#19): account management is superadmin-only ──────────────────────
// One block for all three routes so a future fourth cannot be added without an
// obvious place its gating test is missing. These assert the ROUTE refuses before the
// service runs; the RPCs refuse again in-transaction (admin-roles.db.test.ts), so a
// mistake here is not on its own enough to grant a clerk account management.
describe('account routes are closed to 幹事', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(CLERK_SESSION)
  })

  it.each([
    ['disable', disablePOST, { targetId: TARGET_ID, disabled: true }, setAdminDisabled],
    ['reset-password', resetPOST, { targetId: TARGET_ID }, resetAdminPassword],
    ['revoke-sessions', revokePOST, { targetId: TARGET_ID }, revokeAdminSessions],
    ['create', createPOST, { username: 'newone', role: 'clerk' }, createAdmin],
    ['role', rolePOST, { targetId: TARGET_ID, role: 'clerk' }, setAdminRole],
  ] as const)('clerk → 403 on %s, service never called', async (path, handler, body, service) => {
    const res = await post(handler, path, body)
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'forbidden' })
    // 403, not 401: re-logging in would not help, and the client must not read this
    // as an expired session and bounce the operator to the login form.
    expect(service).not.toHaveBeenCalled()
  })

  it('the refusal happens before body validation, so a clerk cannot probe input handling', async () => {
    const res = await post(disablePOST, 'disable', { targetId: 'not-a-uuid', disabled: 'nope' })
    expect(res.status).toBe(403)
  })
})
