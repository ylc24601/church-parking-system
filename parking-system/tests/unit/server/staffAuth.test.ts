import { beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'

// getStaffSession reads the cookie + the staff_sessions row. Mock next/headers
// (cookie store) and the repo. Hoisted so the factories can reference them.
const { cookieGet, getStaffSessionById } = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  getStaffSessionById: vi.fn(),
}))

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({ get: cookieGet, set: vi.fn(), delete: vi.fn() })),
}))
vi.mock('@/server/repositories/parkingRepository', () => ({
  createParkingRepository: vi.fn(() => ({ getStaffSessionById })),
}))

import { getStaffSession } from '@/server/http/staffAuth'

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    weekly_event_id: 'event-1',
    pin_hash: 'scrypt$aa$bb',
    expires_at: new Date(Date.now() + 3600_000),
    failed_attempts: 0,
    locked_at: null,
    ...over,
  }
}

describe('getStaffSession', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns null when there is no cookie', async () => {
    cookieGet.mockReturnValue(undefined)
    expect(await getStaffSession()).toBeNull()
    expect(getStaffSessionById).not.toHaveBeenCalled()
  })

  it('returns null when the session row is missing', async () => {
    cookieGet.mockReturnValue({ value: 's1' })
    getStaffSessionById.mockResolvedValue(null)
    expect(await getStaffSession()).toBeNull()
  })

  it('returns the bound session when live', async () => {
    cookieGet.mockReturnValue({ value: 's1' })
    getStaffSessionById.mockResolvedValue(sessionRow())
    expect(await getStaffSession()).toEqual({ sessionId: 's1', eventId: 'event-1' })
  })

  it('IGNORES locked_at — a brute-force lock does not evict a live cookie session', async () => {
    cookieGet.mockReturnValue({ value: 's1' })
    getStaffSessionById.mockResolvedValue(sessionRow({ locked_at: new Date() }))
    expect(await getStaffSession()).toEqual({ sessionId: 's1', eventId: 'event-1' })
  })

  it('returns null once the session has expired', async () => {
    cookieGet.mockReturnValue({ value: 's1' })
    getStaffSessionById.mockResolvedValue(sessionRow({ expires_at: new Date(Date.now() - 1000) }))
    expect(await getStaffSession()).toBeNull()
  })
})
