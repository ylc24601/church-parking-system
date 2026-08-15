import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// Hoisted repo spy for the finalize guard (route calls repo.getWeeklyEvent).
const { getWeeklyEvent } = vi.hoisted(() => ({ getWeeklyEvent: vi.fn() }))

vi.mock('@/server/services/attendanceService', () => ({ checkIn: vi.fn() }))
vi.mock('@/server/repositories/parkingRepository', () => ({
  createParkingRepository: vi.fn(() => ({ getWeeklyEvent })),
}))
vi.mock('@/server/http/staffAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/staffAuth')>()
  return { ...actual, getStaffSession: vi.fn() }
})

import { POST } from '@/app/api/staff/checkin/route'
import { checkIn } from '@/server/services/attendanceService'
import { getStaffSession } from '@/server/http/staffAuth'

const SESSION = { sessionId: 's1', eventId: 'event-A' }
const post = (body: unknown) =>
  POST(new Request('http://localhost/api/staff/checkin', { method: 'POST', body: JSON.stringify(body) }))

beforeEach(() => {
  vi.clearAllMocks()
  getWeeklyEvent.mockResolvedValue({ id: 'event-A', sunday_date: '2026-06-21', status: 'open' })
})

describe('POST /api/staff/checkin', () => {
  it('401s when there is no session', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(null)
    const res = await post({ reservationId: 'r1' })
    expect(res.status).toBe(401)
    expect(checkIn).not.toHaveBeenCalled()
  })

  it('400s when reservationId is missing', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(SESSION)
    const res = await post({})
    expect(res.status).toBe(400)
    expect(checkIn).not.toHaveBeenCalled()
  })

  it('409s when the event is finalized (checkIn not called)', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(SESSION)
    getWeeklyEvent.mockResolvedValue({ id: 'event-A', sunday_date: '2026-06-21', status: 'finalized' })
    const res = await post({ reservationId: 'r1' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: 'event_finalized' })
    expect(checkIn).not.toHaveBeenCalled()
  })

  it('returns a Staff-safe DTO and binds the session event', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(SESSION)
    ;(checkIn as Mock).mockResolvedValue({
      attended: true,
      status: 'attended_after_release',
      penaltyUpdated: true, // must NOT leak to Staff
    })

    const res = await post({ reservationId: 'r1' })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, attended: true, status: 'attended_after_release' })
    expect(json).not.toHaveProperty('penaltyUpdated')
    expect(checkIn).toHaveBeenCalledWith({ reservationId: 'r1', eventId: 'event-A' }, expect.anything())
  })

  it('409s when the reservation belongs to a different event (cross-event reject)', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(SESSION)
    ;(checkIn as Mock).mockRejectedValue(new Error('wrong_event'))
    const res = await post({ reservationId: 'r-from-event-B' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: 'wrong_event' })
  })

  it('404s when the reservation does not exist', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(SESSION)
    ;(checkIn as Mock).mockRejectedValue(new Error('reservation r1 not found'))
    const res = await post({ reservationId: 'r1' })
    expect(res.status).toBe(404)
  })
})
