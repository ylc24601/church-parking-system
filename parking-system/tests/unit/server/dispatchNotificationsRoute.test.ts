import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// Thin internal job route: auth (x-job-secret OR Vercel-Cron bearer), validate limit,
// GET (query) + POST (body), dryRun preview, operation-safe responses.
vi.mock('@/server/http/jobAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/jobAuth')>()
  return { ...actual, cronOrJobSecretValid: vi.fn() }
})
vi.mock('@/server/services/notificationDispatchService', () => ({
  dispatchNotifications: vi.fn(),
  previewDispatch: vi.fn(),
}))

import { GET, POST } from '@/app/api/internal/jobs/dispatch-notifications/route'
import { cronOrJobSecretValid } from '@/server/http/jobAuth'
import { dispatchNotifications, previewDispatch } from '@/server/services/notificationDispatchService'

const URL_BASE = 'http://localhost/api/internal/jobs/dispatch-notifications'
const post = (body: unknown, headers: Record<string, string> = { 'x-job-secret': 'secret' }) =>
  POST(new Request(URL_BASE, { method: 'POST', headers, body: JSON.stringify(body) }))
const get = (qs = '', headers: Record<string, string> = { 'x-job-secret': 'secret' }) =>
  GET(new Request(`${URL_BASE}${qs}`, { headers }))

const SUMMARY = { scanned: 3, sent: 2, retried: 1, failed: 0, skippedNoLineId: 0 }
const PREVIEW = { dryRun: true, due: 3, dueByTemplate: { move_car_request: 2 }, staleProcessing: 1, batchLimit: 100 }

describe('/api/internal/jobs/dispatch-notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(cronOrJobSecretValid as Mock).mockReturnValue(true)
    ;(dispatchNotifications as Mock).mockResolvedValue(SUMMARY)
    ;(previewDispatch as Mock).mockResolvedValue(PREVIEW)
  })

  it('POST 401s when auth fails', async () => {
    ;(cronOrJobSecretValid as Mock).mockReturnValue(false)
    const res = await post({})
    expect(res.status).toBe(401)
    expect(dispatchNotifications).not.toHaveBeenCalled()
  })

  it('GET 401s when auth fails', async () => {
    ;(cronOrJobSecretValid as Mock).mockReturnValue(false)
    const res = await get()
    expect(res.status).toBe(401)
    expect(dispatchNotifications).not.toHaveBeenCalled()
  })

  it('GET dispatches (Vercel Cron / scheduler path) and returns counts-only', async () => {
    const res = await get('', { authorization: 'Bearer croncron' })
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, ...SUMMARY })
    expect(dispatchNotifications).toHaveBeenCalledWith({ limit: undefined })
  })

  it('POST 400s on an invalid limit, without calling the service', async () => {
    for (const limit of [0, 1.5, -1, 'ten']) {
      const res = await post({ limit })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ ok: false, error: 'invalid limit' })
    }
    expect(dispatchNotifications).not.toHaveBeenCalled()
  })

  it('GET 400s on an invalid ?limit', async () => {
    expect((await get('?limit=0')).status).toBe(400)
    expect((await get('?limit=abc')).status).toBe(400)
    expect(dispatchNotifications).not.toHaveBeenCalled()
  })

  it('dryRun returns the no-mutation preview (GET ?dryRun=1 and POST {dryRun:true})', async () => {
    const g = await get('?dryRun=1')
    expect(await g.json()).toEqual({ ok: true, ...PREVIEW })
    const p = await post({ dryRun: true })
    expect(await p.json()).toEqual({ ok: true, ...PREVIEW })
    expect(previewDispatch).toHaveBeenCalledTimes(2)
    expect(dispatchNotifications).not.toHaveBeenCalled()
  })

  it('response is operation-safe (no per-row / sensitive keys)', async () => {
    const json = await (await post({})).json()
    for (const k of ['line_id', 'user_id', 'reservation_id', 'dedupe_key', 'payload_json', 'license_plate', 'phone', 'penalty', 'pastoral']) {
      expect(JSON.stringify(json)).not.toContain(k)
    }
  })

  it('500s when the dispatcher throws (e.g. mock_in_production)', async () => {
    ;(dispatchNotifications as Mock).mockRejectedValue(new Error('mock_in_production'))
    const res = await post({})
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'mock_in_production' })
  })
})
