import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@/server/http/jobAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/jobAuth')>()
  return { ...actual, cronOrJobSecretValid: vi.fn() }
})
vi.mock('@/server/services/requeueFailedService', () => ({ requeueFailed: vi.fn() }))

import { POST } from '@/app/api/internal/jobs/requeue-failed/route'
import { cronOrJobSecretValid } from '@/server/http/jobAuth'
import { requeueFailed } from '@/server/services/requeueFailedService'

const post = (body?: unknown, headers: Record<string, string> = { 'x-job-secret': 'secret' }) =>
  POST(new Request('http://localhost/api/internal/jobs/requeue-failed', {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }))

describe('POST /api/internal/jobs/requeue-failed', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(cronOrJobSecretValid as Mock).mockReturnValue(true)
    ;(requeueFailed as Mock).mockResolvedValue({ dryRun: true, wouldRequeue: 4 })
  })

  it('401s when auth fails, without touching the service', async () => {
    ;(cronOrJobSecretValid as Mock).mockReturnValue(false)
    expect((await post({})).status).toBe(401)
    expect(requeueFailed).not.toHaveBeenCalled()
  })

  it('defaults to dryRun with no body', async () => {
    await post(undefined)
    expect(requeueFailed).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }))
  })

  it('defaults to dryRun when dryRun is omitted', async () => {
    await post({ max: 10 })
    expect(requeueFailed).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true, max: 10 }))
  })

  it('mutates only on an explicit dryRun:false', async () => {
    ;(requeueFailed as Mock).mockResolvedValue({ dryRun: false, requeued: 2 })
    const r = await post({ dryRun: false })
    expect(requeueFailed).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }))
    expect(await r.json()).toEqual({ ok: true, dryRun: false, requeued: 2 })
  })

  it('400s on an invalid max (non-positive / non-integer) and does not call the service', async () => {
    expect((await post({ max: 0 })).status).toBe(400)
    expect((await post({ max: 1.5 })).status).toBe(400)
    expect((await post({ max: -3 })).status).toBe(400)
    expect(requeueFailed).not.toHaveBeenCalled()
  })

  it('response is aggregate-only — no per-row / sensitive keys', async () => {
    const s = JSON.stringify(await (await post({})).json())
    for (const k of ['payload_json', 'user_id', 'reservation_id', 'dedupe_key', 'line_id', 'license_plate']) {
      expect(s).not.toContain(`"${k}"`)
    }
    for (const sub of ['phone', 'penalty', 'pastoral']) expect(s).not.toContain(sub)
  })
})
