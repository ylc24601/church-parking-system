import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// Phase 9 Slice 1 — thin schedulable route: cron-or-job-secret guard, body ignored,
// pass-through summary. Mock the guard (keep unauthorized real) and the service.
vi.mock('@/server/http/jobAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/jobAuth')>()
  return { ...actual, cronOrJobSecretValid: vi.fn() }
})
vi.mock('@/server/services/ensureWeeklyEventService', () => ({ ensureUpcomingWeeklyEvent: vi.fn() }))

import { POST } from '@/app/api/internal/jobs/ensure-weekly-event/route'
import { cronOrJobSecretValid } from '@/server/http/jobAuth'
import { ensureUpcomingWeeklyEvent } from '@/server/services/ensureWeeklyEventService'

const post = (body?: unknown) =>
  POST(
    new Request('http://localhost/api/internal/jobs/ensure-weekly-event', {
      method: 'POST',
      headers: { 'x-job-secret': 'secret' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )

const SUMMARY = { created: true, eventId: 'event-9', sundayDate: '2026-07-19', status: 'open' }

describe('POST /api/internal/jobs/ensure-weekly-event', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(cronOrJobSecretValid as Mock).mockReturnValue(true)
    ;(ensureUpcomingWeeklyEvent as Mock).mockResolvedValue(SUMMARY)
  })

  it('401s when neither secret is valid', async () => {
    ;(cronOrJobSecretValid as Mock).mockReturnValue(false)
    const res = await post({})
    expect(res.status).toBe(401)
    expect(ensureUpcomingWeeklyEvent).not.toHaveBeenCalled()
  })

  it('creates (or confirms) the upcoming event and returns the summary', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, ...SUMMARY })
    expect(ensureUpcomingWeeklyEvent).toHaveBeenCalledOnce()
    expect(ensureUpcomingWeeklyEvent).toHaveBeenCalledWith()
  })

  it('reports created=false idempotent re-runs as a plain 200', async () => {
    ;(ensureUpcomingWeeklyEvent as Mock).mockResolvedValue({ ...SUMMARY, created: false })
    const res = await post({})
    expect(res.status).toBe(200)
    expect((await res.json()).created).toBe(false)
  })

  it('ignores the request body entirely — a scheduler payload cannot steer the target', async () => {
    await post({ sunday: '2031-01-05', eventId: 'junk', extra: true })
    // Called with NO arguments: the service derives the Sunday itself.
    expect(ensureUpcomingWeeklyEvent).toHaveBeenCalledWith()
  })

  it('500s with the sanitized message when the service throws', async () => {
    ;(ensureUpcomingWeeklyEvent as Mock).mockRejectedValue(new Error('ensure boom'))
    const res = await post({})
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'ensure boom' })
  })
})
