import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// Repo spy hoisted so requireWritableEvent (which reads getWeeklyEvent) can be steered.
const { getWeeklyEvent } = vi.hoisted(() => ({ getWeeklyEvent: vi.fn() }))

vi.mock('@/server/services/moveCarService', () => ({ requestMoveCar: vi.fn() }))
vi.mock('@/server/repositories/parkingRepository', () => ({
  createParkingRepository: vi.fn(() => ({ getWeeklyEvent })),
}))
vi.mock('@/server/http/staffAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/staffAuth')>()
  return { ...actual, getStaffSession: vi.fn() }
})

import { POST } from '@/app/api/staff/move-car/route'
import { requestMoveCar } from '@/server/services/moveCarService'
import { getStaffSession } from '@/server/http/staffAuth'

const SESSION = { sessionId: 's1', eventId: 'event-1' }
const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/staff/move-car', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )

beforeEach(() => {
  vi.clearAllMocks()
  getWeeklyEvent.mockResolvedValue({ id: 'event-1', sunday_date: '2026-06-21', status: 'open' })
  ;(getStaffSession as Mock).mockResolvedValue(SESSION)
  ;(requestMoveCar as Mock).mockResolvedValue({ queued: true })
})

describe('POST /api/staff/move-car', () => {
  it('401s when there is no session', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(null)
    const res = await post({ reservationId: 'r1' })
    expect(res.status).toBe(401)
    expect(requestMoveCar).not.toHaveBeenCalled()
  })

  it('400s when reservationId is missing', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    expect(requestMoveCar).not.toHaveBeenCalled()
  })

  it('409s when the event is already finalized (service not called)', async () => {
    getWeeklyEvent.mockResolvedValue({ id: 'event-1', sunday_date: '2026-06-21', status: 'finalized' })
    const res = await post({ reservationId: 'r1' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: 'event_finalized' })
    expect(requestMoveCar).not.toHaveBeenCalled()
  })

  it('409s on wrong_event', async () => {
    ;(requestMoveCar as Mock).mockRejectedValue(new Error('wrong_event'))
    const res = await post({ reservationId: 'r1' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: 'wrong_event' })
  })

  it('404s when the reservation does not exist', async () => {
    ;(requestMoveCar as Mock).mockRejectedValue(new Error('reservation r1 not found'))
    const res = await post({ reservationId: 'r1' })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: 'not_found' })
  })

  it('422s when the owner is not notifiable', async () => {
    ;(requestMoveCar as Mock).mockResolvedValue({ queued: false, reason: 'not_notifiable' })
    const res = await post({ reservationId: 'r1' })
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ ok: false, error: 'not_notifiable' })
  })

  it('200 queued with a Staff-safe DTO — never leaks line_id/user_id/plate/text', async () => {
    const res = await post({ reservationId: 'r1' })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, queued: true })
    expect(requestMoveCar).toHaveBeenCalledWith({ reservationId: 'r1', eventId: 'event-1' }, expect.anything())
    for (const forbidden of ['line_id', 'user_id', 'license_plate', 'plate', 'text', 'message', 'phone_number']) {
      expect(JSON.stringify(json)).not.toContain(forbidden)
    }
  })

  it('500s when the service throws unexpectedly', async () => {
    ;(requestMoveCar as Mock).mockRejectedValue(new Error('boom'))
    const res = await post({ reservationId: 'r1' })
    expect(res.status).toBe(500)
    expect((await res.json()).ok).toBe(false)
  })
})
