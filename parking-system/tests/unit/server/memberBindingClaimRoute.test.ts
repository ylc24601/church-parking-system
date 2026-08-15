import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@/server/services/memberBindingService', () => ({ submitBindingClaim: vi.fn() }))

import { POST } from '@/app/api/member/binding-claim/route'
import { MemberAuthConfigError } from '@/server/services/memberAuthService'
import { submitBindingClaim } from '@/server/services/memberBindingService'

const post = (body: string, headers: Record<string, string> = { 'content-type': 'application/json' }) =>
  POST(new Request('http://localhost/api/member/binding-claim', { method: 'POST', headers, body }))

const VALID = JSON.stringify({ mockLineUserId: 'U_x', name: '王小明', phone: '0912345678' })

describe('POST /api/member/binding-claim', () => {
  beforeEach(() => vi.clearAllMocks())

  it('200 + no-store on a recorded claim', async () => {
    ;(submitBindingClaim as Mock).mockResolvedValue({ ok: true })
    const res = await post(VALID)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: true })
  })

  it('415 on a non-JSON content type (service untouched)', async () => {
    const res = await post('name=x', { 'content-type': 'application/x-www-form-urlencoded' })
    expect(res.status).toBe(415)
    expect(submitBindingClaim).not.toHaveBeenCalled()
  })

  it('413 on an oversized body (service untouched)', async () => {
    const res = await post(JSON.stringify({ name: 'x'.repeat(5000) }))
    expect(res.status).toBe(413)
    expect(submitBindingClaim).not.toHaveBeenCalled()
  })

  it('413 measures UTF-8 BYTES: CJK payload under 4096 chars but over 4096 bytes is rejected', async () => {
    // 1500 CJK chars ≈ 1500 UTF-16 units (< 4096) but ≈ 4500 UTF-8 bytes (> 4096).
    const cjk = JSON.stringify({ name: '停'.repeat(1500) })
    expect(cjk.length).toBeLessThan(4096)
    expect(Buffer.byteLength(cjk, 'utf8')).toBeGreaterThan(4096)
    const res = await post(cjk)
    expect(res.status).toBe(413)
    expect(submitBindingClaim).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid_request', 400],
    ['invalid_token', 401],
    ['verify_unreachable', 503],
    ['line_account_already_bound', 200],
  ] as const)('%s → %i with the typed reason', async (reason, status) => {
    ;(submitBindingClaim as Mock).mockResolvedValue({ ok: false, reason })
    const res = await post(VALID)
    expect(res.status).toBe(status)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({ ok: false, reason })
  })

  it('config faults → 500 generic marker', async () => {
    ;(submitBindingClaim as Mock).mockRejectedValue(new MemberAuthConfigError('mock_in_production'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(VALID)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'config' })
    spy.mockRestore()
  })

  it('malformed JSON still reaches the service as an empty object (→ its invalid_request)', async () => {
    ;(submitBindingClaim as Mock).mockResolvedValue({ ok: false, reason: 'invalid_request' })
    const res = await post('not-json')
    expect(res.status).toBe(400)
    expect(submitBindingClaim).toHaveBeenCalledWith({})
  })
})
