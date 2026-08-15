import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// Mock the service (PIN verification) and the cookie setter.
vi.mock('@/server/services/staffSessionService', () => ({ loginStaff: vi.fn() }))
vi.mock('@/server/http/staffAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/staffAuth')>()
  return { ...actual, setStaffSession: vi.fn() }
})

import { POST } from '@/app/api/staff/login/route'
import { loginStaff } from '@/server/services/staffSessionService'
import { setStaffSession } from '@/server/http/staffAuth'

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/staff/login', { method: 'POST', body: JSON.stringify(body) }))

describe('POST /api/staff/login', () => {
  beforeEach(() => vi.clearAllMocks())

  it('200 + sets the session cookie on success', async () => {
    ;(loginStaff as Mock).mockResolvedValue({ ok: true, sessionId: 's1', eventId: 'e1' })
    const res = await post({ pin: '246810' })
    expect(res.status).toBe(200)
    expect(setStaffSession).toHaveBeenCalledWith('s1')
  })

  it('401 invalid_pin on an invalid result (no session set)', async () => {
    ;(loginStaff as Mock).mockResolvedValue({ ok: false, reason: 'invalid' })
    const res = await post({ pin: '000000' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_pin' })
    expect(setStaffSession).not.toHaveBeenCalled()
  })

  it('423 locked when the PIN is locked out', async () => {
    ;(loginStaff as Mock).mockResolvedValue({ ok: false, reason: 'locked' })
    const res = await post({ pin: '000000' })
    expect(res.status).toBe(423)
    expect(await res.json()).toEqual({ ok: false, error: 'locked' })
  })

  it('401 when no PIN is supplied (service not called)', async () => {
    const res = await post({})
    expect(res.status).toBe(401)
    expect(loginStaff).not.toHaveBeenCalled()
  })
})
