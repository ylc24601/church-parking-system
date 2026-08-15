import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// Repo spies are hoisted so the mock factory + tests share them.
const { getWeeklyEvent, finalizeWeeklyEvent } = vi.hoisted(() => ({
  getWeeklyEvent: vi.fn(),
  finalizeWeeklyEvent: vi.fn(),
}))

vi.mock('@/server/services/settlementService', () => ({ settle: vi.fn() }))
vi.mock('@/server/repositories/parkingRepository', () => ({
  createParkingRepository: vi.fn(() => ({ getWeeklyEvent, finalizeWeeklyEvent })),
}))
vi.mock('@/server/http/staffAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/staffAuth')>()
  return { ...actual, getStaffSession: vi.fn() }
})

import { POST } from '@/app/api/staff/settle/route'
import { settle } from '@/server/services/settlementService'
import { getStaffSession } from '@/server/http/staffAuth'

const SESSION = { sessionId: 's1', eventId: 'event-1' }
const post = () => POST()

beforeEach(() => {
  vi.clearAllMocks()
  getWeeklyEvent.mockResolvedValue({ id: 'event-1', sunday_date: '2026-06-21', status: 'open' })
  finalizeWeeklyEvent.mockResolvedValue(undefined)
})

describe('POST /api/staff/settle', () => {
  it('401s when there is no session', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(null)
    const res = await post()
    expect(res.status).toBe(401)
    expect(settle).not.toHaveBeenCalled()
  })

  it('settles, finalizes AFTER, and returns a STRICT Staff-safe DTO', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(SESSION)
    // Service returns the full summary incl. sensitive penalty/pastoral counts...
    ;(settle as Mock).mockResolvedValue({ releasedNow: 1, settled: 3, penaltiesApplied: 3, alertsCreated: 1 })

    const res = await post()
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, settled: 3, releasedNow: 1, finalized: true })
    // finalize runs after settle
    expect(finalizeWeeklyEvent.mock.invocationCallOrder[0]).toBeGreaterThan(
      (settle as Mock).mock.invocationCallOrder[0],
    )
    expect(finalizeWeeklyEvent).toHaveBeenCalledWith('event-1')
    // ...but no sensitive field ever leaks to Staff.
    const keys = Object.keys(json)
    for (const forbidden of [
      'penaltiesApplied', 'alertsCreated', 'penalties', 'alerts', 'penalty', 'pastoral',
      'phone_number', 'line_id', 'p2_reason',
    ]) {
      expect(keys).not.toContain(forbidden)
    }
  })

  it('returns finalized:false when finalize fails after a successful settle (retryable)', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(SESSION)
    ;(settle as Mock).mockResolvedValue({ releasedNow: 0, settled: 0, penaltiesApplied: 0, alertsCreated: 0 })
    finalizeWeeklyEvent.mockRejectedValue(new Error('db down'))

    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, settled: 0, releasedNow: 0, finalized: false })
  })

  it('409s when the event is already finalized (settle/finalize not called)', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(SESSION)
    getWeeklyEvent.mockResolvedValue({ id: 'event-1', sunday_date: '2026-06-21', status: 'finalized' })

    const res = await post()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: 'event_finalized' })
    expect(settle).not.toHaveBeenCalled()
    expect(finalizeWeeklyEvent).not.toHaveBeenCalled()
  })

  it('binds the session event (settle called with session.eventId)', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(SESSION)
    ;(settle as Mock).mockResolvedValue({ releasedNow: 0, settled: 0, penaltiesApplied: 0, alertsCreated: 0 })
    await post()
    expect(settle).toHaveBeenCalledWith({ eventId: 'event-1' }, expect.anything())
  })

  it('500s when the settlement service throws', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(SESSION)
    ;(settle as Mock).mockRejectedValue(new Error('boom'))
    const res = await post()
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
  })
})
