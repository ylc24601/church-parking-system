import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// First unit test for an internal job route: mock the job-secret guard (keep unauthorized
// real) and the service. The route is a thin wrapper — validate auth, graceDays, pass-through.
vi.mock('@/server/http/jobAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/jobAuth')>()
  return { ...actual, jobSecretValid: vi.fn() }
})
vi.mock('@/server/services/autoFinalizeService', () => ({ autoFinalizeStaleEvents: vi.fn() }))

import { POST } from '@/app/api/internal/jobs/auto-finalize/route'
import { jobSecretValid } from '@/server/http/jobAuth'
import { autoFinalizeStaleEvents } from '@/server/services/autoFinalizeService'

const post = (body: unknown) =>
  POST(
    new Request('http://localhost/api/internal/jobs/auto-finalize', {
      method: 'POST',
      headers: { 'x-job-secret': 'secret' },
      body: JSON.stringify(body),
    }),
  )

const SUMMARY = { scanned: 1, finalized: 1, failed: 0, results: [
  { eventId: 'e1', sunday_date: '2099-05-17', releasedNow: 0, settled: 1, finalized: true },
] }

describe('POST /api/internal/jobs/auto-finalize', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(jobSecretValid as Mock).mockReturnValue(true)
    ;(autoFinalizeStaleEvents as Mock).mockResolvedValue(SUMMARY)
  })

  it('401s when the job secret is missing/invalid', async () => {
    ;(jobSecretValid as Mock).mockReturnValue(false)
    const res = await post({})
    expect(res.status).toBe(401)
    expect(autoFinalizeStaleEvents).not.toHaveBeenCalled()
  })

  it('400s on an invalid graceDays (non-integer / < 1 / non-number), without calling the service', async () => {
    for (const graceDays of [0, 1.5, -1, 'two']) {
      const res = await post({ graceDays })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, error: 'invalid graceDays' })
    }
    expect(autoFinalizeStaleEvents).not.toHaveBeenCalled()
  })

  it('runs the sweep and returns the operation-safe summary', async () => {
    const res = await post({})
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, ...SUMMARY })
    expect(autoFinalizeStaleEvents).toHaveBeenCalledWith({ graceDays: undefined })
    // no penalty/pastoral/member/vehicle detail in the response
    for (const forbidden of ['penaltiesApplied', 'alertsCreated', 'pastoral', 'phone_number', 'line_id', 'p2_reason']) {
      expect(JSON.stringify(json)).not.toContain(forbidden)
    }
  })

  it('passes an explicit valid graceDays through to the service', async () => {
    await post({ graceDays: 3 })
    expect(autoFinalizeStaleEvents).toHaveBeenCalledWith({ graceDays: 3 })
  })

  it('500s when the service throws', async () => {
    ;(autoFinalizeStaleEvents as Mock).mockRejectedValue(new Error('scan boom'))
    const res = await post({})
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'scan boom' })
  })
})
