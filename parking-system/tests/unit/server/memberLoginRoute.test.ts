import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// Mock the service (identity verification) and the cookie layer.
vi.mock('@/server/services/memberAuthService', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/services/memberAuthService')>()
  return { ...actual, loginMember: vi.fn() }
})
vi.mock('@/server/http/memberAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/memberAuth')>()
  return { ...actual, getMemberSession: vi.fn(), setMemberSession: vi.fn() }
})

import { POST } from '@/app/api/member/login/route'
import { MemberAuthConfigError, loginMember } from '@/server/services/memberAuthService'
import { getMemberSession, setMemberSession } from '@/server/http/memberAuth'

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/member/login', { method: 'POST', body: JSON.stringify(body) }))

describe('POST /api/member/login', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getMemberSession as Mock).mockResolvedValue(null)
  })

  it('idempotent: a live session short-circuits without re-verifying or minting', async () => {
    ;(getMemberSession as Mock).mockResolvedValue({ sessionId: 's1', userId: 'u1' })
    const res = await post({ mockLineUserId: 'U_x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(loginMember).not.toHaveBeenCalled()
    expect(setMemberSession).not.toHaveBeenCalled()
  })

  it('200 + session cookie + no-store on success', async () => {
    ;(loginMember as Mock).mockResolvedValue({ ok: true, token: 'raw-token' })
    const res = await post({ mockLineUserId: 'U_x' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(setMemberSession).toHaveBeenCalledWith('raw-token')
  })

  it('not_bound is an expected state: 200 with the typed reason, no cookie', async () => {
    ;(loginMember as Mock).mockResolvedValue({ ok: false, reason: 'not_bound' })
    const res = await post({ mockLineUserId: 'U_x' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: false, reason: 'not_bound' })
    expect(setMemberSession).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid_request', 400],
    ['invalid_token', 401],
    ['verify_unreachable', 503],
  ] as const)('%s → %i', async (reason, status) => {
    ;(loginMember as Mock).mockResolvedValue({ ok: false, reason })
    const res = await post({})
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ ok: false, reason })
  })

  it('config faults → 500 generic marker (code stays server-side)', async () => {
    ;(loginMember as Mock).mockRejectedValue(new MemberAuthConfigError('mock_in_production'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post({ mockLineUserId: 'U_x' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'config' })
    expect(setMemberSession).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('malformed JSON body → 400 invalid_request path via the service', async () => {
    ;(loginMember as Mock).mockResolvedValue({ ok: false, reason: 'invalid_request' })
    const res = await POST(
      new Request('http://localhost/api/member/login', { method: 'POST', body: 'not-json' }),
    )
    expect(res.status).toBe(400)
    expect(loginMember).toHaveBeenCalledWith({})
  })
})
