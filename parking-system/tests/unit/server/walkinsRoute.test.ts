import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// Mock the session guard (avoids next/headers cookie context), the repo factory
// (finalize guard reads getWeeklyEvent), and the service. The route binds to the
// session event, not a client id.
const { getWeeklyEvent } = vi.hoisted(() => ({ getWeeklyEvent: vi.fn() }))

vi.mock('@/server/services/walkInService', () => ({ registerWalkIn: vi.fn() }))
vi.mock('@/server/repositories/parkingRepository', () => ({
  createParkingRepository: vi.fn(() => ({ getWeeklyEvent })),
}))
vi.mock('@/server/http/staffAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/staffAuth')>()
  return { ...actual, getStaffSession: vi.fn() }
})

import { POST } from '@/app/api/staff/walkins/route'
import { registerWalkIn } from '@/server/services/walkInService'
import { getStaffSession } from '@/server/http/staffAuth'

const SESSION = { sessionId: 's1', eventId: 'event-1' }
const post = (body: unknown) =>
  POST(new Request('http://localhost/api/staff/walkins', { method: 'POST', body: JSON.stringify(body) }))

const safeRow = {
  reservation_id: 'walkin-1',
  weekly_event_id: 'event-1',
  display_name: null,
  license_plate: null,
  walk_in_name: '訪客',
  walk_in_license_plate: 'NEW-1',
  is_priority: false,
  status: 'walk_in',
  attended_at: '2026-06-21T02:00:00.000Z',
}

describe('POST /api/staff/walkins', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getWeeklyEvent.mockResolvedValue({ id: 'event-1', sunday_date: '2026-06-21', status: 'open' })
  })

  it('401s when there is no session', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(null)
    const res = await post({ license_plate: 'NEW-1' })
    expect(res.status).toBe(401)
    expect(registerWalkIn).not.toHaveBeenCalled()
  })

  it('409s when the event is finalized (registerWalkIn not called)', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(SESSION)
    getWeeklyEvent.mockResolvedValue({ id: 'event-1', sunday_date: '2026-06-21', status: 'finalized' })
    const res = await post({ license_plate: 'NEW-1' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: 'event_finalized' })
    expect(registerWalkIn).not.toHaveBeenCalled()
  })

  it('400s when license_plate is missing/blank', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(SESSION)
    expect((await post({})).status).toBe(400)
    expect((await post({ license_plate: '   ' })).status).toBe(400)
    expect(registerWalkIn).not.toHaveBeenCalled()
  })

  it('409s on duplicate', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(SESSION)
    ;(registerWalkIn as Mock).mockResolvedValue({ created: false, duplicate: true })
    const res = await post({ license_plate: 'ABC-1234' })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ ok: false, error: 'duplicate' })
  })

  it('binds the session event and returns a Staff-safe row (no sensitive fields)', async () => {
    ;(getStaffSession as Mock).mockResolvedValue(SESSION)
    ;(registerWalkIn as Mock).mockResolvedValue({ created: true, row: safeRow })

    const res = await post({ license_plate: 'NEW-1', walk_in_name: '訪客' })
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.row).toEqual(safeRow)
    expect(registerWalkIn).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: 'event-1', plate: 'NEW-1' }),
      expect.anything(),
    )
    const keys = Object.keys(json.row)
    for (const forbidden of ['user_id', 'vehicle_id', 'effective_priority', 'penalty_score', 'applied_at']) {
      expect(keys).not.toContain(forbidden)
    }
  })
})
