import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@/server/http/jobAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/jobAuth')>()
  return { ...actual, cronOrJobSecretValid: vi.fn() }
})
vi.mock('@/server/services/outboxHealthService', () => ({ getOutboxHealth: vi.fn() }))

import { GET } from '@/app/api/internal/jobs/outbox-status/route'
import { cronOrJobSecretValid } from '@/server/http/jobAuth'
import { getOutboxHealth } from '@/server/services/outboxHealthService'

const HEALTH = {
  due: 2, due_by_template: { move_car_request: 2 }, pending: 4, retrying: 1, processing: 0,
  stale_processing: 0, failed: 3, failed_by_error: { no_line_id: 2, terminal_403: 1 },
  sent_last_24h: 12, oldest_pending_at: '2026-06-21T01:00:00Z', oldest_due_at: '2026-06-21T01:00:00Z', oldest_failed_at: '2026-06-20T09:00:00Z',
  next_retry_at: '2026-06-21T03:00:00Z',
}
const get = (headers: Record<string, string> = { 'x-job-secret': 'secret' }) =>
  GET(new Request('http://localhost/api/internal/jobs/outbox-status', { headers }))

describe('GET /api/internal/jobs/outbox-status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(cronOrJobSecretValid as Mock).mockReturnValue(true)
    ;(getOutboxHealth as Mock).mockResolvedValue(HEALTH)
  })

  it('401s when auth fails', async () => {
    ;(cronOrJobSecretValid as Mock).mockReturnValue(false)
    expect((await get()).status).toBe(401)
    expect(getOutboxHealth).not.toHaveBeenCalled()
  })

  it('returns the operation-safe health summary (x-job-secret and cron bearer both work)', async () => {
    const a = await get()
    expect(a.status).toBe(200)
    expect(await a.json()).toEqual({ ok: true, ...HEALTH })
    await get({ authorization: 'Bearer cron' })
    expect(getOutboxHealth).toHaveBeenCalledTimes(2)
  })

  it('is aggregate-only — no per-row / sensitive keys', async () => {
    const s = JSON.stringify(await (await get()).json())
    // Exact sensitive field names as JSON keys (quoted) — the quoted form avoids a false
    // positive on the benign sanitized error CODE "no_line_id" in failed_by_error.
    for (const key of ['payload_json', 'user_id', 'reservation_id', 'dedupe_key', 'line_id', 'license_plate']) {
      expect(s).not.toContain(`"${key}"`)
    }
    for (const sub of ['phone', 'penalty', 'pastoral']) {
      expect(s).not.toContain(sub)
    }
  })

  it('500s when the health service throws', async () => {
    ;(getOutboxHealth as Mock).mockRejectedValue(new Error('boom'))
    expect((await get()).status).toBe(500)
  })
})
