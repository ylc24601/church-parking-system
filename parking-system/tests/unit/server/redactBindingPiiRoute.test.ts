import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@/server/services/bindingPiiRetentionService', () => ({ redactBindingPii: vi.fn() }))

import { GET, POST } from '@/app/api/internal/jobs/redact-binding-pii/route'
import { redactBindingPii } from '@/server/services/bindingPiiRetentionService'

const URL_BASE = 'http://localhost/api/internal/jobs/redact-binding-pii'
const SECRET_HEADER = { 'x-job-secret': 'test-job-secret' }

const get = (query = '', headers: Record<string, string> = SECRET_HEADER) =>
  GET(new Request(`${URL_BASE}${query}`, { headers }))

const post = (body: unknown, headers: Record<string, string> = SECRET_HEADER) =>
  POST(new Request(URL_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }))

describe('/api/internal/jobs/redact-binding-pii', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.JOB_TRIGGER_SECRET = 'test-job-secret'
    process.env.CRON_SECRET = 'test-cron-secret'
    ;(redactBindingPii as Mock).mockResolvedValue({
      dryRun: true, wouldRedact: 0, hasMore: false, retentionDays: 90, cutoff: '2026-04-14T00:00:00.000Z',
    })
  })

  it('401 without a secret; x-job-secret and cron Bearer both pass', async () => {
    expect((await get('', {})).status).toBe(401)
    expect((await post({}, { 'content-type': 'application/json' })).status).toBe(401)
    expect(redactBindingPii).not.toHaveBeenCalled()
    expect((await get('')).status).toBe(200)
    expect((await get('', { authorization: 'Bearer test-cron-secret' })).status).toBe(200)
  })

  it('GET with no params → APPLY (the scheduler entry point exists to do the work)', async () => {
    ;(redactBindingPii as Mock).mockResolvedValue({ dryRun: false, redacted: 2, retentionDays: 90, cutoff: 'c' })
    const res = await get('')
    expect(res.status).toBe(200)
    expect(redactBindingPii).toHaveBeenCalledWith({ dryRun: false, max: undefined })
    expect(await res.json()).toEqual({ ok: true, dryRun: false, redacted: 2, retentionDays: 90, cutoff: 'c' })
  })

  it('GET dryRun=1|true → preview; dryRun=0|false → apply; anything else → 400', async () => {
    await get('?dryRun=1')
    expect(redactBindingPii).toHaveBeenLastCalledWith({ dryRun: true, max: undefined })
    await get('?dryRun=true')
    expect(redactBindingPii).toHaveBeenLastCalledWith({ dryRun: true, max: undefined })
    await get('?dryRun=0')
    expect(redactBindingPii).toHaveBeenLastCalledWith({ dryRun: false, max: undefined })
    await get('?dryRun=false')
    expect(redactBindingPii).toHaveBeenLastCalledWith({ dryRun: false, max: undefined })
    ;(redactBindingPii as Mock).mockClear()
    expect((await get('?dryRun=yes')).status).toBe(400)
    expect((await get('?dryRun=')).status).toBe(400)
    expect(redactBindingPii).not.toHaveBeenCalled()
  })

  it('POST {} → DRY-RUN (human path must never apply by omission)', async () => {
    const res = await post({})
    expect(res.status).toBe(200)
    expect(redactBindingPii).toHaveBeenCalledWith({ dryRun: true, max: undefined })
  })

  it('POST dryRun:true → dry-run; explicit false → apply; non-boolean → 400', async () => {
    await post({ dryRun: true })
    expect(redactBindingPii).toHaveBeenLastCalledWith({ dryRun: true, max: undefined })
    ;(redactBindingPii as Mock).mockResolvedValue({ dryRun: false, redacted: 1, retentionDays: 90, cutoff: 'c' })
    await post({ dryRun: false })
    expect(redactBindingPii).toHaveBeenLastCalledWith({ dryRun: false, max: undefined })
    ;(redactBindingPii as Mock).mockClear()
    expect((await post({ dryRun: 'false' })).status).toBe(400)
    expect((await post({ dryRun: 'true' })).status).toBe(400)
    expect((await post({ dryRun: 1 })).status).toBe(400)
    expect(redactBindingPii).not.toHaveBeenCalled()
  })

  it('max: 0 / -1 / 1.5 / 501 / non-number → 400; 500 passes; missing → undefined', async () => {
    for (const bad of [0, -1, 1.5, 501, '50']) {
      expect((await post({ dryRun: true, max: bad })).status).toBe(400)
    }
    expect((await get('?max=0')).status).toBe(400)
    expect((await get('?max=abc')).status).toBe(400)
    expect(redactBindingPii).not.toHaveBeenCalled()
    expect((await post({ dryRun: true, max: 500 })).status).toBe(200)
    expect(redactBindingPii).toHaveBeenLastCalledWith({ dryRun: true, max: 500 })
    await get('?dryRun=1&max=100')
    expect(redactBindingPii).toHaveBeenLastCalledWith({ dryRun: true, max: 100 })
  })

  it('smuggled now / retentionDays never reach the service (window is env-only, now is server time)', async () => {
    await post({ dryRun: true, now: '2030-01-01T00:00:00Z', retentionDays: 1 })
    expect(redactBindingPii).toHaveBeenLastCalledWith({ dryRun: true, max: undefined })
    await get('?dryRun=1&now=2030-01-01T00:00:00Z&retentionDays=1')
    expect(redactBindingPii).toHaveBeenLastCalledWith({ dryRun: true, max: undefined })
  })

  it('service throw → 500', async () => {
    ;(redactBindingPii as Mock).mockRejectedValue(new Error('boom'))
    expect((await get('')).status).toBe(500)
    expect((await post({})).status).toBe(500)
  })
})
