import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@/server/services/auditRetentionService', () => ({ purgeAuditLogs: vi.fn() }))

import { GET, POST } from '@/app/api/internal/jobs/purge-audit-logs/route'
import { purgeAuditLogs } from '@/server/services/auditRetentionService'

const URL_BASE = 'http://localhost/api/internal/jobs/purge-audit-logs'
const SECRET_HEADER = { 'x-job-secret': 'test-job-secret' }
const DRY = { dryRun: true, wouldPurge: 0, deletedBefore: '2024-07-17T15:00:00+00:00', retentionMonths: 24 }

const get = (query = '', headers: Record<string, string> = SECRET_HEADER) =>
  GET(new Request(`${URL_BASE}${query}`, { headers }))

const post = (body: unknown, headers: Record<string, string> = SECRET_HEADER) =>
  POST(new Request(URL_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }))

describe('/api/internal/jobs/purge-audit-logs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.JOB_TRIGGER_SECRET = 'test-job-secret'
    process.env.CRON_SECRET = 'test-cron-secret'
    ;(purgeAuditLogs as Mock).mockResolvedValue(DRY)
  })

  it('401 without a secret; x-job-secret and cron Bearer both pass', async () => {
    expect((await get('', {})).status).toBe(401)
    expect((await post({}, { 'content-type': 'application/json' })).status).toBe(401)
    expect(purgeAuditLogs).not.toHaveBeenCalled()
    expect((await get('')).status).toBe(200)
    expect((await get('', { authorization: 'Bearer test-cron-secret' })).status).toBe(200)
  })

  it('GET with no params → APPLY (the scheduler entry point exists to do the work)', async () => {
    ;(purgeAuditLogs as Mock).mockResolvedValue({
      dryRun: false, deletedCount: 2, batches: 1, hasMore: false,
      deletedBefore: '2024-07-17T15:00:00+00:00', retentionMonths: 24,
    })
    const res = await get('')
    expect(res.status).toBe(200)
    expect(purgeAuditLogs).toHaveBeenCalledWith({ dryRun: false, max: undefined })
    expect(await res.json()).toEqual({
      ok: true, dryRun: false, deletedCount: 2, batches: 1, hasMore: false,
      deletedBefore: '2024-07-17T15:00:00+00:00', retentionMonths: 24,
    })
  })

  it('an apply run that leaves a backlog surfaces a visible warning', async () => {
    ;(purgeAuditLogs as Mock).mockResolvedValue({
      dryRun: false, deletedCount: 10_000, batches: 20, hasMore: true,
      deletedBefore: '2024-07-17T15:00:00+00:00', retentionMonths: 24,
    })
    const body = await (await get('')).json()
    expect(body.hasMore).toBe(true)
    expect(typeof body.warning).toBe('string')
    expect(body.warning.length).toBeGreaterThan(0)
  })

  it('a dry run never carries a warning field', async () => {
    const body = await (await get('?dryRun=1')).json()
    expect('warning' in body).toBe(false)
  })

  it('GET dryRun=1|true → preview; dryRun=0|false → apply; anything else → 400', async () => {
    await get('?dryRun=1')
    expect(purgeAuditLogs).toHaveBeenLastCalledWith({ dryRun: true, max: undefined })
    await get('?dryRun=true')
    expect(purgeAuditLogs).toHaveBeenLastCalledWith({ dryRun: true, max: undefined })
    await get('?dryRun=0')
    expect(purgeAuditLogs).toHaveBeenLastCalledWith({ dryRun: false, max: undefined })
    await get('?dryRun=false')
    expect(purgeAuditLogs).toHaveBeenLastCalledWith({ dryRun: false, max: undefined })
    ;(purgeAuditLogs as Mock).mockClear()
    expect((await get('?dryRun=yes')).status).toBe(400)
    expect((await get('?dryRun=')).status).toBe(400)
    expect(purgeAuditLogs).not.toHaveBeenCalled()
  })

  it('POST {} → DRY-RUN (human path must never delete by omission)', async () => {
    const res = await post({})
    expect(res.status).toBe(200)
    expect(purgeAuditLogs).toHaveBeenCalledWith({ dryRun: true, max: undefined })
  })

  it('POST dryRun:true → dry-run; explicit false → apply; non-boolean → 400', async () => {
    await post({ dryRun: true })
    expect(purgeAuditLogs).toHaveBeenLastCalledWith({ dryRun: true, max: undefined })
    ;(purgeAuditLogs as Mock).mockResolvedValue({
      dryRun: false, deletedCount: 1, batches: 1, hasMore: false,
      deletedBefore: '2024-07-17T15:00:00+00:00', retentionMonths: 24,
    })
    await post({ dryRun: false })
    expect(purgeAuditLogs).toHaveBeenLastCalledWith({ dryRun: false, max: undefined })
    ;(purgeAuditLogs as Mock).mockClear()
    expect((await post({ dryRun: 'false' })).status).toBe(400)
    expect((await post({ dryRun: 'true' })).status).toBe(400)
    expect((await post({ dryRun: 1 })).status).toBe(400)
    expect(purgeAuditLogs).not.toHaveBeenCalled()
  })

  it('max: 0 / -1 / 1.5 / 501 / non-number → 400; 500 passes; missing → undefined', async () => {
    for (const bad of [0, -1, 1.5, 501, '50']) {
      expect((await post({ dryRun: true, max: bad })).status).toBe(400)
    }
    expect((await get('?max=0')).status).toBe(400)
    expect((await get('?max=abc')).status).toBe(400)
    expect(purgeAuditLogs).not.toHaveBeenCalled()
    expect((await post({ dryRun: true, max: 500 })).status).toBe(200)
    expect(purgeAuditLogs).toHaveBeenLastCalledWith({ dryRun: true, max: 500 })
    await get('?dryRun=1&max=100')
    expect(purgeAuditLogs).toHaveBeenLastCalledWith({ dryRun: true, max: 100 })
  })

  it('smuggled now / retentionMonths never reach the service (DB clock + env-only window)', async () => {
    await post({ dryRun: true, now: '2100-01-01T00:00:00Z', retentionMonths: 1 })
    expect(purgeAuditLogs).toHaveBeenLastCalledWith({ dryRun: true, max: undefined })
    await get('?dryRun=1&now=2100-01-01T00:00:00Z&retentionMonths=1')
    expect(purgeAuditLogs).toHaveBeenLastCalledWith({ dryRun: true, max: undefined })
  })

  it('service throw → 500', async () => {
    ;(purgeAuditLogs as Mock).mockRejectedValue(new Error('boom'))
    expect((await get('')).status).toBe(500)
    expect((await post({})).status).toBe(500)
  })
})
