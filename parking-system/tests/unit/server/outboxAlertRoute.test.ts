import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@/server/http/jobAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/jobAuth')>()
  return { ...actual, cronOrJobSecretValid: vi.fn() }
})
vi.mock('@/server/services/outboxAlertService', () => ({ getOutboxAlert: vi.fn() }))

import { GET } from '@/app/api/internal/jobs/outbox-alert/route'
import { cronOrJobSecretValid } from '@/server/http/jobAuth'
import { getOutboxAlert } from '@/server/services/outboxAlertService'

const THRESHOLDS = { failedMax: 0, staleMax: 0, pendingStaleMinutes: 15 }
const HEALTHY = { healthy: true, breaches: [], thresholds: THRESHOLDS, failed: 0, stale_processing: 0, oldest_due_at: null }
const UNHEALTHY = { ...HEALTHY, healthy: false, breaches: ['failed_over_max'], failed: 3 }

const get = (headers: Record<string, string> = { 'x-job-secret': 'secret' }) =>
  GET(new Request('http://localhost/api/internal/jobs/outbox-alert', { headers }))

describe('GET /api/internal/jobs/outbox-alert', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(cronOrJobSecretValid as Mock).mockReturnValue(true)
    ;(getOutboxAlert as Mock).mockResolvedValue(HEALTHY)
  })

  it('401s when auth fails', async () => {
    ;(cronOrJobSecretValid as Mock).mockReturnValue(false)
    expect((await get()).status).toBe(401)
    expect(getOutboxAlert).not.toHaveBeenCalled()
  })

  it('200 when healthy', async () => {
    const r = await get()
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, ...HEALTHY })
  })

  it('503 when unhealthy (so an external monitor/cron alerts)', async () => {
    ;(getOutboxAlert as Mock).mockResolvedValue(UNHEALTHY)
    const r = await get()
    expect(r.status).toBe(503)
    expect((await r.json()).breaches).toContain('failed_over_max')
  })

  it('is aggregate-only — no per-row / sensitive keys', async () => {
    ;(getOutboxAlert as Mock).mockResolvedValue(UNHEALTHY)
    const s = JSON.stringify(await (await get()).json())
    for (const k of ['payload_json', 'user_id', 'reservation_id', 'dedupe_key', 'line_id', 'license_plate']) {
      expect(s).not.toContain(`"${k}"`)
    }
    for (const sub of ['phone', 'penalty', 'pastoral']) expect(s).not.toContain(sub)
  })

  it('500s when the service throws', async () => {
    ;(getOutboxAlert as Mock).mockRejectedValue(new Error('boom'))
    expect((await get()).status).toBe(500)
  })
})
