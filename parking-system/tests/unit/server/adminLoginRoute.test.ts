import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@/server/services/adminAuthService', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/services/adminAuthService')>()
  return { ...actual, loginAdmin: vi.fn() }
})
vi.mock('@/server/http/adminAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/adminAuth')>()
  return { ...actual, getAdminSession: vi.fn(), setAdminSession: vi.fn() }
})

import { POST } from '@/app/api/admin/login/route'
import { loginAdmin } from '@/server/services/adminAuthService'
import { getAdminSession, setAdminSession } from '@/server/http/adminAuth'

const URL_ = 'http://localhost/api/admin/login'

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

describe('POST /api/admin/login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(null)
  })

  it('200 + cookie set with the RAW token + no-store on success', async () => {
    ;(loginAdmin as Mock).mockResolvedValue({ ok: true, token: 'raw-token' })
    const res = await post({ username: 'alice', password: 'pw-long-enough' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(setAdminSession).toHaveBeenCalledWith('raw-token')
  })

  it('idempotent: a live session short-circuits without re-verifying', async () => {
    ;(getAdminSession as Mock).mockResolvedValue({ sessionId: 's1', adminId: 'a1', username: 'alice' })
    const res = await post({ username: 'alice', password: 'whatever-here' })
    expect(res.status).toBe(200)
    expect(loginAdmin).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid'],
    ['locked'],
  ] as const)('service %s → ONE unified 401 invalid (no lock oracle)', async reason => {
    ;(loginAdmin as Mock).mockResolvedValue({ ok: false, reason })
    const res = await post({ username: 'alice', password: 'wrong-password' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, reason: 'invalid' })
    expect(setAdminSession).not.toHaveBeenCalled()
  })

  it('missing / non-string fields → 400 invalid_request', async () => {
    for (const body of [{}, { username: 'alice' }, { username: 42, password: 'x'.repeat(12) }, { username: 'alice', password: '' }]) {
      expect((await post(body)).status).toBe(400)
    }
    expect(loginAdmin).not.toHaveBeenCalled()
  })

  it('non-JSON content type → 415; oversized body → 413; malformed JSON → 400', async () => {
    const nonJson = await POST(new Request(URL_, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' }))
    expect(nonJson.status).toBe(415)

    const big = await post({ username: 'alice', password: 'p'.repeat(5000) })
    expect(big.status).toBe(413)

    const malformed = await post('not-json{')
    expect(malformed.status).toBe(400)
    expect(loginAdmin).not.toHaveBeenCalled()
  })

  it('foreign Origin → 403 before anything else runs', async () => {
    const res = await post({ username: 'alice', password: 'pw-long-enough' }, { origin: 'https://evil.example' })
    expect(res.status).toBe(403)
    expect(getAdminSession).not.toHaveBeenCalled()
    expect(loginAdmin).not.toHaveBeenCalled()
  })

  it('same-origin Origin header passes', async () => {
    ;(loginAdmin as Mock).mockResolvedValue({ ok: true, token: 'raw-token' })
    const res = await post({ username: 'alice', password: 'pw-long-enough' }, { origin: 'http://localhost' })
    expect(res.status).toBe(200)
  })

  it('service throw → 500 generic (no message, no PII), cookie untouched', async () => {
    ;(loginAdmin as Mock).mockRejectedValue(new Error('createAdminSession failed: boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post({ username: 'alice', password: 'pw-long-enough' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'internal' })
    expect(setAdminSession).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
