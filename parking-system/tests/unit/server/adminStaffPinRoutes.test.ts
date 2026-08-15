import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@/server/services/staffPinAdminService', () => ({
  issueStaffPin: vi.fn(),
  unlockStaffPin: vi.fn(),
}))
vi.mock('@/server/http/adminAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/adminAuth')>()
  return { ...actual, getAdminSession: vi.fn() }
})

import { POST as issuePOST } from '@/app/api/admin/staff-pin/issue/route'
import { POST as unlockPOST } from '@/app/api/admin/staff-pin/unlock/route'
import { issueStaffPin, unlockStaffPin } from '@/server/services/staffPinAdminService'
import { getAdminSession } from '@/server/http/adminAuth'

const SESSION = { sessionId: 's1', adminId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', username: 'alice' }
const EVENT_ID = '11111111-aaaa-bbbb-cccc-000000000001'
const SUNDAY = '2026-07-19'

const call = (handler: typeof issuePOST, path: string) =>
  (body: unknown, headers: Record<string, string> = {}) =>
    handler(new Request(`http://localhost/api/admin/staff-pin/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }))
const postIssue = call(issuePOST, 'issue')
const postUnlock = call(unlockPOST, 'unlock')

describe('admin staff-pin routes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    ;(issueStaffPin as Mock).mockResolvedValue({
      ok: true, pin: '004217', eventId: EVENT_ID, sunday: SUNDAY, expiresAt: '2026-07-19T16:00:00.000Z',
    })
    ;(unlockStaffPin as Mock).mockResolvedValue({ ok: true, eventId: EVENT_ID, sunday: SUNDAY })
  })

  it('401 / 415 / 403 guard matrix on both routes; service never touched', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    expect((await postIssue({ eventId: EVENT_ID, sunday: SUNDAY })).status).toBe(401)
    expect((await postUnlock({ eventId: EVENT_ID, sunday: SUNDAY })).status).toBe(401)
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    expect((await postIssue({ eventId: EVENT_ID, sunday: SUNDAY }, { origin: 'https://evil.example' })).status).toBe(403)
    const nonJson = await issuePOST(new Request('http://localhost/api/admin/staff-pin/issue', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x',
    }))
    expect(nonJson.status).toBe(415)
    expect(issueStaffPin).not.toHaveBeenCalled()
    expect(unlockStaffPin).not.toHaveBeenCalled()
  })

  it('shape validation: bad eventId / bad sunday format → 400 before the service', async () => {
    for (const body of [
      { eventId: 'nope', sunday: SUNDAY },
      { eventId: EVENT_ID, sunday: '2026/07/19' },
      { eventId: EVENT_ID },
      { sunday: SUNDAY },
    ]) {
      expect((await postIssue(body)).status).toBe(400)
      expect((await postUnlock(body)).status).toBe(400)
    }
    expect(issueStaffPin).not.toHaveBeenCalled()
    expect(unlockStaffPin).not.toHaveBeenCalled()
  })

  it('issue: 200 carries the one-time pin + verification echo, no-store; adminId from session', async () => {
    const res = await postIssue({ eventId: EVENT_ID, sunday: SUNDAY, adminId: 'attacker' })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      ok: true, pin: '004217', eventId: EVENT_ID, sunday: SUNDAY, expiresAt: '2026-07-19T16:00:00.000Z',
    })
    expect(issueStaffPin).toHaveBeenCalledWith({ eventId: EVENT_ID, sunday: SUNDAY, adminId: SESSION.adminId })
  })

  it('typed refusals map honestly: event_not_found 404, mismatch/unmanaged 400, no_pin 404', async () => {
    ;(issueStaffPin as Mock).mockResolvedValue({ ok: false, reason: 'event_not_found' })
    expect((await postIssue({ eventId: EVENT_ID, sunday: SUNDAY })).status).toBe(404)
    ;(issueStaffPin as Mock).mockResolvedValue({ ok: false, reason: 'sunday_mismatch' })
    expect((await postIssue({ eventId: EVENT_ID, sunday: SUNDAY })).status).toBe(400)
    ;(issueStaffPin as Mock).mockResolvedValue({ ok: false, reason: 'sunday_not_managed' })
    expect((await postIssue({ eventId: EVENT_ID, sunday: SUNDAY })).status).toBe(400)
    ;(unlockStaffPin as Mock).mockResolvedValue({ ok: false, reason: 'no_pin' })
    expect((await postUnlock({ eventId: EVENT_ID, sunday: SUNDAY })).status).toBe(404)
  })

  it('unlock: success returns NO pin material', async () => {
    const res = await postUnlock({ eventId: EVENT_ID, sunday: SUNDAY })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json).toEqual({ ok: true, eventId: EVENT_ID, sunday: SUNDAY })
    expect(JSON.stringify(json)).not.toMatch(/pin"?:/)
  })

  it('service throw → 500 generic on both routes', async () => {
    ;(issueStaffPin as Mock).mockRejectedValue(new Error('boom'))
    ;(unlockStaffPin as Mock).mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await postIssue({ eventId: EVENT_ID, sunday: SUNDAY })).status).toBe(500)
    expect((await postUnlock({ eventId: EVENT_ID, sunday: SUNDAY })).status).toBe(500)
    spy.mockRestore()
  })
})
