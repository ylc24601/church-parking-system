import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@/server/services/memberAdminService', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/services/memberAdminService')>()
  return { ...actual, searchMembers: vi.fn(), issueMemberBindingCode: vi.fn() }
})
vi.mock('@/server/http/adminAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/adminAuth')>()
  return { ...actual, getAdminSession: vi.fn() }
})

import { POST as searchPOST } from '@/app/api/admin/members/search/route'
import { POST as codePOST } from '@/app/api/admin/members/binding-code/route'
import { searchMembers, issueMemberBindingCode } from '@/server/services/memberAdminService'
import { getAdminSession } from '@/server/http/adminAuth'

const SESSION = { sessionId: 's1', adminId: 'admin-1', username: 'alice' }
const USER_ID = 'a1b2c3d4-1111-4222-8333-000000000001'

const post = (handler: typeof searchPOST, path: string, body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request(`http://localhost/api/admin/members/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

describe('POST /api/admin/members/search', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
  })

  it('no session → 401, service never called', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    const res = await post(searchPOST, 'search', { query: '王' })
    expect(res.status).toBe(401)
    expect(searchMembers).not.toHaveBeenCalled()
  })

  it('415 non-JSON / 413 oversized / 400 malformed / 403 foreign Origin', async () => {
    const nonJson = await searchPOST(new Request('http://localhost/api/admin/members/search', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x',
    }))
    expect(nonJson.status).toBe(415)
    expect((await post(searchPOST, 'search', { query: '愛'.repeat(2000) })).status).toBe(413)
    expect((await post(searchPOST, 'search', 'not-json{')).status).toBe(400)
    expect((await post(searchPOST, 'search', { query: '王' }, { origin: 'https://evil.example' })).status).toBe(403)
  })

  it.each([
    ['non-string', { query: 42 }],
    ['empty', { query: '   ' }],
    ['too long', { query: 'a'.repeat(51) }],
    ['missing', {}],
  ])('invalid query (%s) → 400', async (_n, body) => {
    expect((await post(searchPOST, 'search', body)).status).toBe(400)
    expect(searchMembers).not.toHaveBeenCalled()
  })

  it('200 with masked items + hasMore + no-store; response carries no full phone', async () => {
    ;(searchMembers as Mock).mockResolvedValue({
      items: [{ id: USER_ID, displayName: '王小明', phoneMasked: '0912***678', plateSummary: 'ABC-1234', role: 'user', bound: false }],
      hasMore: true,
    })
    const res = await post(searchPOST, 'search', { query: '王' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body).toEqual({
      ok: true, hasMore: true,
      items: [{ id: USER_ID, displayName: '王小明', phoneMasked: '0912***678', plateSummary: 'ABC-1234', role: 'user', bound: false }],
    })
    expect(JSON.stringify(body)).not.toContain('0912345678')
  })

  it('service throw → 500 generic, and the query is never logged', async () => {
    ;(searchMembers as Mock).mockRejectedValue(new Error('0987654321 boom')) // message even holds a number
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(searchPOST, 'search', { query: '0987654321' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'internal' })
    // No console.error call carries the query or the error's PII-ish message.
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('0987654321')
    }
    spy.mockRestore()
  })
})

describe('POST /api/admin/members/binding-code', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    ;(issueMemberBindingCode as Mock).mockResolvedValue({ ok: true, code: 'ABCD-2345', expiresAt: '2026-08-01T00:00:00Z', displayName: '王小明' })
  })

  it('no session → 401', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    expect((await post(codePOST, 'binding-code', { userId: USER_ID })).status).toBe(401)
    expect(issueMemberBindingCode).not.toHaveBeenCalled()
  })

  it('non-UUID userId → 400', async () => {
    for (const bad of [undefined, 42, 'abc', `${USER_ID}x`]) {
      expect((await post(codePOST, 'binding-code', { userId: bad })).status).toBe(400)
    }
    expect(issueMemberBindingCode).not.toHaveBeenCalled()
  })

  it('ttlDays boundary: 1 & 90 pass; 0 / 91 / 1.5 / non-number → 400', async () => {
    for (const good of [1, 90]) {
      expect((await post(codePOST, 'binding-code', { userId: USER_ID, ttlDays: good })).status).toBe(200)
    }
    for (const bad of [0, 91, 1.5, '30', Number.MAX_SAFE_INTEGER + 1]) {
      expect((await post(codePOST, 'binding-code', { userId: USER_ID, ttlDays: bad })).status).toBe(400)
    }
  })

  it('note: ≤200 code points passes, 201 or non-string → 400; emoji counted as code points', async () => {
    expect((await post(codePOST, 'binding-code', { userId: USER_ID, note: '愛'.repeat(200) })).status).toBe(200)
    expect((await post(codePOST, 'binding-code', { userId: USER_ID, note: '愛'.repeat(201) })).status).toBe(400)
    expect((await post(codePOST, 'binding-code', { userId: USER_ID, note: '😀'.repeat(150) })).status).toBe(200) // 150 code points
    expect((await post(codePOST, 'binding-code', { userId: USER_ID, note: 42 })).status).toBe(400)
  })

  it('createdBy is ALWAYS the session username; a smuggled body value is ignored', async () => {
    await post(codePOST, 'binding-code', { userId: USER_ID, createdBy: 'attacker', adminId: 'attacker' })
    expect(issueMemberBindingCode).toHaveBeenCalledWith(expect.objectContaining({ createdBy: 'admin:alice' }))
  })

  it('trimmed-empty note becomes null', async () => {
    await post(codePOST, 'binding-code', { userId: USER_ID, note: '   ' })
    expect(issueMemberBindingCode).toHaveBeenCalledWith(expect.objectContaining({ note: null }))
  })

  it('success → 200 full code + no-store; the code is never logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(codePOST, 'binding-code', { userId: USER_ID })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true, code: 'ABCD-2345', expiresAt: '2026-08-01T00:00:00Z', displayName: '王小明' })
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('ABCD-2345')
    spy.mockRestore()
  })

  it.each([
    ['already_bound'],
    ['member_not_found'],
  ] as const)('typed %s → 200 with the reason', async reason => {
    ;(issueMemberBindingCode as Mock).mockResolvedValue({ ok: false, reason })
    const res = await post(codePOST, 'binding-code', { userId: USER_ID })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, reason })
  })

  it('service throw → 500 generic', async () => {
    ;(issueMemberBindingCode as Mock).mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(codePOST, 'binding-code', { userId: USER_ID })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'internal' })
    spy.mockRestore()
  })
})
