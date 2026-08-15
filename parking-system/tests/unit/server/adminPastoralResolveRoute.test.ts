import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@/server/services/pastoralAlertService', () => ({ resolvePastoralAlert: vi.fn() }))
vi.mock('@/server/http/adminAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/adminAuth')>()
  return { ...actual, getAdminSession: vi.fn() }
})

import { POST } from '@/app/api/admin/pastoral/resolve/route'
import { resolvePastoralAlert } from '@/server/services/pastoralAlertService'
import { getAdminSession } from '@/server/http/adminAuth'

const SESSION = { sessionId: 's1', adminId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', username: 'alice' }
const ALERT_ID = '11111111-2222-3333-4444-555555555555'

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request('http://localhost/api/admin/pastoral/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

describe('POST /api/admin/pastoral/resolve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    ;(resolvePastoralAlert as Mock).mockResolvedValue({ ok: true, counterReset: false })
  })

  it('401 no session / 415 non-JSON / 413 oversized / 400 malformed / 403 foreign Origin', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    expect((await post({ alertId: ALERT_ID })).status).toBe(401)
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    const nonJson = await POST(new Request('http://localhost/api/admin/pastoral/resolve', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x',
    }))
    expect(nonJson.status).toBe(415)
    expect((await post({ pad: 'x'.repeat(5000) })).status).toBe(413)
    expect((await post('not-json{')).status).toBe(400)
    expect((await post({ alertId: ALERT_ID }, { origin: 'https://evil.example' })).status).toBe(403)
    expect(resolvePastoralAlert).not.toHaveBeenCalled()
  })

  it('alertId must be a UUID; note must be a string within 200 code points; resetCounter boolean-only', async () => {
    expect((await post({ alertId: 'nope' })).status).toBe(400)
    expect((await post({ alertId: ALERT_ID, note: 42 })).status).toBe(400)
    expect((await post({ alertId: ALERT_ID, note: '安'.repeat(201) })).status).toBe(400)
    expect((await post({ alertId: ALERT_ID, resetCounter: 'true' })).status).toBe(400)
    expect((await post({ alertId: ALERT_ID, resetCounter: 1 })).status).toBe(400)
    expect(resolvePastoralAlert).not.toHaveBeenCalled()
  })

  it('adminId comes from the SESSION only — a smuggled adminId/now never reaches the service', async () => {
    const res = await post({ alertId: ALERT_ID, adminId: 'attacker', now: '2000-01-01', resetCounter: true })
    expect(res.status).toBe(200)
    expect(resolvePastoralAlert).toHaveBeenCalledWith({
      alertId: ALERT_ID,
      adminId: SESSION.adminId,
      note: null,
      resetCounter: true,
    })
  })

  it('resetCounter defaults to false when omitted (fail-safe: never reset by omission)', async () => {
    await post({ alertId: ALERT_ID })
    expect(resolvePastoralAlert).toHaveBeenCalledWith(expect.objectContaining({ resetCounter: false }))
  })

  it('typed outcomes map to honest statuses: resolved 200 / already_resolved 409 / not_found 404', async () => {
    ;(resolvePastoralAlert as Mock).mockResolvedValue({ ok: true, counterReset: true })
    const okRes = await post({ alertId: ALERT_ID, resetCounter: true })
    expect(okRes.status).toBe(200)
    expect(okRes.headers.get('cache-control')).toBe('no-store')
    expect(await okRes.json()).toEqual({ ok: true, counterReset: true })

    ;(resolvePastoralAlert as Mock).mockResolvedValue({ ok: false, reason: 'already_resolved' })
    const dup = await post({ alertId: ALERT_ID })
    expect(dup.status).toBe(409)
    expect(await dup.json()).toEqual({ ok: false, reason: 'already_resolved' })

    ;(resolvePastoralAlert as Mock).mockResolvedValue({ ok: false, reason: 'not_found' })
    expect((await post({ alertId: ALERT_ID })).status).toBe(404)
  })

  it('service throw → 500 generic', async () => {
    ;(resolvePastoralAlert as Mock).mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post({ alertId: ALERT_ID })
    expect(res.status).toBe(500)
    spy.mockRestore()
  })
})
