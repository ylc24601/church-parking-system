import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// Phase 9 Slice 1 — the five weekly job routes share one eventId contract (see
// server/http/jobEventResolver.ts): omitted → resolve the upcoming Sunday's event,
// present-but-invalid → 400, no upcoming event → 503, explicit UUID → unchanged
// pass-through. The resolver runs REAL here; only auth, the repository factory and
// the services are mocked, so each route is exercised end-to-end at the handler level.
vi.mock('@/server/http/jobAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/jobAuth')>()
  return { ...actual, jobSecretValid: vi.fn() }
})
vi.mock('@/server/repositories/parkingRepository', () => ({ createParkingRepository: vi.fn() }))
vi.mock('@/server/services/releaseService', () => ({ runRelease: vi.fn() }))
vi.mock('@/server/services/offerExpiryService', () => ({ expireOffers: vi.fn() }))
vi.mock('@/server/services/autoApproveService', () => ({ autoApproveTemp: vi.fn() }))
vi.mock('@/server/services/p2ReminderService', () => ({ sendArrivalReminders: vi.fn() }))
vi.mock('@/server/services/fridayAllocationService', () => ({ runFridayAllocation: vi.fn() }))

import { POST as releasePost } from '@/app/api/internal/jobs/release/route'
import { POST as expireOffersPost } from '@/app/api/internal/jobs/expire-offers/route'
import { POST as autoApprovePost } from '@/app/api/internal/jobs/auto-approve-temp/route'
import { POST as p2ReminderPost } from '@/app/api/internal/jobs/p2-arrival-reminder/route'
import { POST as fridayPost } from '@/app/api/jobs/friday-allocation/route'
import { jobSecretValid } from '@/server/http/jobAuth'
import { createParkingRepository } from '@/server/repositories/parkingRepository'
import { runRelease } from '@/server/services/releaseService'
import { expireOffers } from '@/server/services/offerExpiryService'
import { autoApproveTemp } from '@/server/services/autoApproveService'
import { sendArrivalReminders } from '@/server/services/p2ReminderService'
import { runFridayAllocation } from '@/server/services/fridayAllocationService'

const VALID_UUID = '3f2b8c1a-9d4e-4f6a-8b2c-1d3e5f7a9b0c'

const ROUTES = [
  { name: 'release', post: releasePost, service: runRelease as Mock },
  { name: 'expire-offers', post: expireOffersPost, service: expireOffers as Mock },
  { name: 'auto-approve-temp', post: autoApprovePost, service: autoApproveTemp as Mock },
  { name: 'p2-arrival-reminder', post: p2ReminderPost, service: sendArrivalReminders as Mock },
  { name: 'friday-allocation', post: fridayPost, service: runFridayAllocation as Mock },
] as const

const request = (body?: unknown) =>
  new Request('http://localhost/api/jobs/test', {
    method: 'POST',
    headers: { 'x-job-secret': 'secret' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

let getUpcomingScheduledEvent: Mock

describe.each(ROUTES)('POST job route $name — eventId contract', ({ post, service }) => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(jobSecretValid as Mock).mockReturnValue(true)
    getUpcomingScheduledEvent = vi.fn(async () => ({
      id: 'resolved-event',
      sunday_date: '2026-07-19',
      status: 'open',
    }))
    ;(createParkingRepository as Mock).mockReturnValue({ getUpcomingScheduledEvent })
    for (const r of ROUTES) r.service.mockResolvedValue({ processed: 0 })
  })

  it('401s without a valid job secret', async () => {
    ;(jobSecretValid as Mock).mockReturnValue(false)
    const res = await post(request({}))
    expect(res.status).toBe(401)
    expect(service).not.toHaveBeenCalled()
  })

  it('keeps the explicit-eventId manual path unchanged (no DB lookup)', async () => {
    const res = await post(request({ eventId: VALID_UUID }))
    expect(res.status).toBe(200)
    expect(service).toHaveBeenCalledWith({ eventId: VALID_UUID })
    expect(getUpcomingScheduledEvent).not.toHaveBeenCalled()
  })

  it('resolves the upcoming Sunday event when eventId is omitted ({} body)', async () => {
    const res = await post(request({}))
    expect(res.status).toBe(200)
    expect(service).toHaveBeenCalledWith({ eventId: 'resolved-event' })
  })

  it('resolves when there is no body at all (static scheduler POST)', async () => {
    const res = await post(request())
    expect(res.status).toBe(200)
    expect(service).toHaveBeenCalledWith({ eventId: 'resolved-event' })
  })

  it('400s on a present-but-invalid eventId without calling the service', async () => {
    for (const eventId of ['', null, 123, 'not-a-uuid']) {
      const res = await post(request({ eventId }))
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, error: 'invalid eventId' })
    }
    expect(service).not.toHaveBeenCalled()
    expect(getUpcomingScheduledEvent).not.toHaveBeenCalled()
  })

  it('503s upcoming_event_missing when no event exists (scheduler alert path)', async () => {
    getUpcomingScheduledEvent.mockResolvedValue(null)
    const res = await post(request({}))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: 'upcoming_event_missing' })
    expect(service).not.toHaveBeenCalled()
  })

  it('500s with the sanitized message when the service throws', async () => {
    service.mockRejectedValue(new Error('job boom'))
    const res = await post(request({ eventId: VALID_UUID }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'job boom' })
  })
})
