import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('@/server/services/requeueFailedService', () => ({ requeueFailed: vi.fn() }))
vi.mock('@/server/http/adminAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/adminAuth')>()
  return { ...actual, getAdminSession: vi.fn() }
})

import { POST } from '@/app/api/admin/ops/requeue/route'
import { requeueFailed } from '@/server/services/requeueFailedService'
import { getAdminSession } from '@/server/http/adminAuth'

const SESSION = { sessionId: 's1', adminId: 'admin-1', username: 'alice', role: 'superadmin' as const }

const post = (body: unknown, headers: Record<string, string> = {}) =>
  POST(new Request('http://localhost/api/admin/ops/requeue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

describe('POST /api/admin/ops/requeue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
    ;(requeueFailed as Mock).mockResolvedValue({ dryRun: true, wouldRequeue: 4 })
  })

  it('no session → 401, service never called', async () => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    expect((await post({ dryRun: true })).status).toBe(401)
    expect(requeueFailed).not.toHaveBeenCalled()
  })

  it('415 non-JSON / 413 oversized / 400 malformed / 403 foreign Origin', async () => {
    const nonJson = await POST(new Request('http://localhost/api/admin/ops/requeue', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x',
    }))
    expect(nonJson.status).toBe(415)
    expect((await post({ pad: 'x'.repeat(5000) })).status).toBe(413)
    expect((await post('not-json{')).status).toBe(400)
    expect((await post({ dryRun: true }, { origin: 'https://evil.example' })).status).toBe(403)
  })

  it('max: 0 / -1 / 1.5 / 501 / non-number → 400, service not called', async () => {
    for (const bad of [0, -1, 1.5, 501, '50']) {
      expect((await post({ dryRun: true, max: bad })).status).toBe(400)
    }
    expect(requeueFailed).not.toHaveBeenCalled()
  })

  it('max: 500 passes; missing max → service called without a max (uses its default)', async () => {
    expect((await post({ dryRun: true, max: 500 })).status).toBe(200)
    expect(requeueFailed).toHaveBeenCalledWith(expect.objectContaining({ max: 500 }))
    ;(requeueFailed as Mock).mockClear()
    await post({ dryRun: true })
    expect((requeueFailed as Mock).mock.calls[0][0].max).toBeUndefined()
  })

  it('dryRun must be a boolean: the string "false" → 400 (never a silent dry-run 200)', async () => {
    expect((await post({ dryRun: 'false' })).status).toBe(400)
    expect((await post({ dryRun: 1 })).status).toBe(400)
    expect(requeueFailed).not.toHaveBeenCalled()
  })

  it('dryRun fail-safe: omitted / true → dryRun:true; explicit false → dryRun:false', async () => {
    await post({})
    expect(requeueFailed).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }))
    ;(requeueFailed as Mock).mockClear()
    await post({ dryRun: true })
    expect(requeueFailed).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }))
    ;(requeueFailed as Mock).mockClear()
    ;(requeueFailed as Mock).mockResolvedValue({ dryRun: false, requeued: 2 })
    const r = await post({ dryRun: false })
    expect(requeueFailed).toHaveBeenCalledWith(expect.objectContaining({ dryRun: false }))
    expect(await r.json()).toEqual({ ok: true, dryRun: false, requeued: 2 })
  })

  it('errorCode: valid code passes; trimmed-empty → null; non-string / too long / illegal chars → 400', async () => {
    await post({ dryRun: true, errorCode: 'http_500' })
    expect(requeueFailed).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'http_500' }))
    ;(requeueFailed as Mock).mockClear()
    await post({ dryRun: true, errorCode: '   ' })
    expect(requeueFailed).toHaveBeenCalledWith(expect.objectContaining({ errorCode: null }))

    expect((await post({ dryRun: true, errorCode: 42 })).status).toBe(400)
    expect((await post({ dryRun: true, errorCode: 'a'.repeat(101) })).status).toBe(400)
    expect((await post({ dryRun: true, errorCode: 'bad code!!\n' })).status).toBe(400)
  })

  it('ignores smuggled body fields (adminId / now / status never reach the service)', async () => {
    await post({ dryRun: true, max: 10, adminId: 'attacker', now: '2000-01-01', status: 'sent' })
    const arg = (requeueFailed as Mock).mock.calls[0][0]
    expect(arg).toEqual({ dryRun: true, max: 10, errorCode: null })
  })

  it('dry-run success → wouldRequeue; apply success → requeued', async () => {
    const dry = await post({ dryRun: true, max: 5 })
    expect(dry.headers.get('cache-control')).toBe('no-store')
    expect(await dry.json()).toEqual({ ok: true, dryRun: true, wouldRequeue: 4 })
    ;(requeueFailed as Mock).mockResolvedValue({ dryRun: false, requeued: 3 })
    expect(await (await post({ dryRun: false, max: 5 })).json()).toEqual({ ok: true, dryRun: false, requeued: 3 })
  })

  it('service throw → 500 generic', async () => {
    ;(requeueFailed as Mock).mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post({ dryRun: true })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'internal' })
    spy.mockRestore()
  })
})

// ── Wave 2C-1 (#19): ops recovery is superadmin-only ───────────────────────────
// requeue replays real notifications to real members, and judging whether the root
// cause is actually fixed is a maintenance call rather than a 幹事 one.
describe('POST /api/admin/ops/requeue is closed to 幹事', () => {
  it('clerk → 403, requeueFailed never called', async () => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue({ ...SESSION, role: 'clerk' })
    const res = await POST(new Request('http://localhost/api/admin/ops/requeue', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false, max: 10 }),
    }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: 'forbidden' })
    expect(requeueFailed).not.toHaveBeenCalled()
  })
})
