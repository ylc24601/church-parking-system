import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

// The three binding-review routes share the guard + session gate; group them
// (mirrors memberReservationRoutes.test.ts).
vi.mock('@/server/services/bindingAdminService', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/services/bindingAdminService')>()
  return {
    ...actual,
    previewApproveBinding: vi.fn(),
    applyApproveBinding: vi.fn(),
    rejectBinding: vi.fn(),
  }
})
vi.mock('@/server/http/adminAuth', async importOriginal => {
  const actual = await importOriginal<typeof import('@/server/http/adminAuth')>()
  return { ...actual, getAdminSession: vi.fn() }
})

import { POST as previewPOST } from '@/app/api/admin/bindings/preview/route'
import { POST as approvePOST } from '@/app/api/admin/bindings/approve/route'
import { POST as rejectPOST } from '@/app/api/admin/bindings/reject/route'
import {
  applyApproveBinding,
  previewApproveBinding,
  rejectBinding,
} from '@/server/services/bindingAdminService'
import { getAdminSession } from '@/server/http/adminAuth'

const PENDING_ID = 'a1b2c3d4-1111-4222-8333-000000000001'
const SESSION = { sessionId: 's1', adminId: 'admin-1', username: 'alice' }
const RAW_LINE_ID = 'Udeadbeefdeadbeefdeadbeefdeadbeef'

const post = (handler: typeof previewPOST, path: string, body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request(`http://localhost/api/admin/bindings/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))

const fullPreview = () => ({
  found: true,
  pendingStatus: 'pending',
  claimSource: 'liff',
  claimVersion: 2,
  lineUserIdMasked: 'Udeadb…beef',
  submittedCodeMasked: null,
  claimedPhoneMasked: '0912***678',
  claimedName: '王小明',
  matchedUserId: 'user-uuid-should-not-leak',
  matchedDisplayName: '王小明',
  wouldApprove: true,
  reason: 'approved',
})

describe('admin bindings routes — shared gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
  })

  it.each([
    ['preview', previewPOST, 'preview', { pendingId: PENDING_ID }],
    ['approve', approvePOST, 'approve', { pendingId: PENDING_ID, claimVersion: 0 }],
    ['reject', rejectPOST, 'reject', { pendingId: PENDING_ID, reason: 'duplicate' }],
  ] as const)('%s: no session → 401 and the service is never called', async (_n, handler, path, body) => {
    ;(getAdminSession as Mock).mockResolvedValue(null)
    const res = await post(handler, path, body)
    expect(res.status).toBe(401)
    expect(previewApproveBinding).not.toHaveBeenCalled()
    expect(applyApproveBinding).not.toHaveBeenCalled()
    expect(rejectBinding).not.toHaveBeenCalled()
  })

  it.each([
    ['preview', previewPOST, 'preview'],
    ['approve', approvePOST, 'approve'],
    ['reject', rejectPOST, 'reject'],
  ] as const)('%s: 415 non-JSON / 413 oversized / 400 malformed / 403 foreign Origin', async (_n, handler, path) => {
    const nonJson = await handler(new Request(`http://localhost/api/admin/bindings/${path}`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x',
    }))
    expect(nonJson.status).toBe(415)

    const big = await post(handler, path, { pendingId: PENDING_ID, reason: '愛'.repeat(2000) })
    expect(big.status).toBe(413)

    const malformed = await post(handler, path, 'not-json{')
    expect(malformed.status).toBe(400)

    const foreign = await post(handler, path, { pendingId: PENDING_ID }, { origin: 'https://evil.example' })
    expect(foreign.status).toBe(403)
  })

  it.each([
    ['preview', previewPOST, 'preview', {}],
    ['approve', approvePOST, 'approve', { claimVersion: 0 }],
    ['reject', rejectPOST, 'reject', { reason: 'duplicate' }],
  ] as const)('%s: a non-UUID pendingId → 400', async (_n, handler, path, extra) => {
    for (const bad of [undefined, 42, 'abc', `${PENDING_ID}x`, 'a1b2c3d4-…-not-a-uuid']) {
      const res = await post(handler, path, { ...extra, pendingId: bad })
      expect(res.status).toBe(400)
    }
  })
})

describe('POST /api/admin/bindings/preview', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
  })

  it('200 with the WHITELISTED preview — matchedUserId and raw values never leak', async () => {
    ;(previewApproveBinding as Mock).mockResolvedValue(fullPreview())
    const res = await post(previewPOST, 'preview', { pendingId: PENDING_ID })
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(Object.keys(body.preview).sort()).toEqual([
      'claimSource', 'claimVersion', 'claimedName', 'claimedPhoneMasked',
      'found', 'lineUserIdMasked', 'matchedDisplayName', 'pendingStatus',
      'reason', 'submittedCodeMasked', 'wouldApprove',
    ])
    const s = JSON.stringify(body)
    expect(s).not.toContain('matchedUserId')
    expect(s).not.toContain('user-uuid-should-not-leak')
    expect(s).not.toContain(RAW_LINE_ID)
  })

  it('found:false still returns 200 with the typed reason', async () => {
    ;(previewApproveBinding as Mock).mockResolvedValue({ found: false, wouldApprove: false, reason: 'pending_not_found' })
    const res = await post(previewPOST, 'preview', { pendingId: PENDING_ID })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.preview.found).toBe(false)
    expect(body.preview.reason).toBe('pending_not_found')
  })

  it('service throw → 500 generic', async () => {
    ;(previewApproveBinding as Mock).mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(previewPOST, 'preview', { pendingId: PENDING_ID })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'internal' })
    spy.mockRestore()
  })
})

describe('POST /api/admin/bindings/approve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
  })

  it('threads {expectedSupersededCount, adminId from the SESSION} into the service', async () => {
    ;(applyApproveBinding as Mock).mockResolvedValue({ approved: 1, reason: 'approved' })
    const res = await post(approvePOST, 'approve', { pendingId: PENDING_ID, claimVersion: 0 })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, reason: 'approved' })
    expect(applyApproveBinding).toHaveBeenCalledWith({
      pendingId: PENDING_ID,
      expectedSupersededCount: 0,
      adminId: 'admin-1',
    })
  })

  it('a smuggled adminId in the body is IGNORED — the decider is always the session', async () => {
    ;(applyApproveBinding as Mock).mockResolvedValue({ approved: 1, reason: 'approved' })
    await post(approvePOST, 'approve', {
      pendingId: PENDING_ID, claimVersion: 1, adminId: 'attacker', decidedBy: 'attacker', username: 'mallory',
    })
    expect(applyApproveBinding).toHaveBeenCalledWith(
      expect.objectContaining({ adminId: 'admin-1' }),
    )
  })

  it.each([
    [Number.MAX_SAFE_INTEGER, 200],  // largest exact JSON integer: valid
  ] as const)('claimVersion boundary %s → %i', async (claimVersion, status) => {
    ;(applyApproveBinding as Mock).mockResolvedValue({ approved: 1, reason: 'approved' })
    const res = await post(approvePOST, 'approve', { pendingId: PENDING_ID, claimVersion })
    expect(res.status).toBe(status)
  })

  it('claimVersion beyond safe-integer / negative / fractional / missing / string → 400', async () => {
    for (const bad of [Number.MAX_SAFE_INTEGER + 1, -1, 1.5, undefined, '2']) {
      const res = await post(approvePOST, 'approve', { pendingId: PENDING_ID, claimVersion: bad })
      expect(res.status).toBe(400)
    }
    expect(applyApproveBinding).not.toHaveBeenCalled()
  })

  it.each([
    ['pending_not_found', 404],
    ['pending_not_pending', 409],
    ['pending_changed', 409],
    ['code_not_found', 200],
    ['code_expired', 200],
    ['code_consumed', 200],
    // Two names for one outcome. `phone_not_found` is what a pre-0038 DB returns and
    // `unmatched_at_capture` is what a migrated one returns — BOTH must be review
    // outcomes, because an unlisted reason 500s (see the test below). Dropping the old
    // name would break the deploy window before the migration runs; missing the new one
    // would 500 every unmatched LIFF claim the moment it does.
    ['phone_not_found', 200],
    ['unmatched_at_capture', 200],
    ['member_already_bound', 200],
    ['line_id_taken', 200],
  ] as const)('typed reason %s → %i with ok:false', async (reason, status) => {
    ;(applyApproveBinding as Mock).mockResolvedValue({ approved: 0, reason })
    const res = await post(approvePOST, 'approve', { pendingId: PENDING_ID, claimVersion: 3 })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ ok: false, reason })
  })

  it('an unexpected reason maps to 500 generic, not a leaked passthrough', async () => {
    ;(applyApproveBinding as Mock).mockResolvedValue({ approved: 0, reason: 'something_new' })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(approvePOST, 'approve', { pendingId: PENDING_ID, claimVersion: 3 })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ ok: false, error: 'internal' })
    spy.mockRestore()
  })
})

describe('POST /api/admin/bindings/reject', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(getAdminSession as Mock).mockResolvedValue(SESSION)
  })

  it('trims the reason and threads the session adminId', async () => {
    ;(rejectBinding as Mock).mockResolvedValue({ rejected: 1, reason: 'rejected' })
    const res = await post(rejectPOST, 'reject', { pendingId: PENDING_ID, reason: ' 重複申請 ' })
    expect(res.status).toBe(200)
    expect(rejectBinding).toHaveBeenCalledWith({
      pendingId: PENDING_ID,
      reason: '重複申請',
      adminId: 'admin-1',
    })
  })

  it('empty / over-200-code-point reason → 400 (astral chars counted as one)', async () => {
    for (const bad of ['', '   ', '愛'.repeat(201)]) {
      const res = await post(rejectPOST, 'reject', { pendingId: PENDING_ID, reason: bad })
      expect(res.status).toBe(400)
    }
    // 150 astral emoji = 300 UTF-16 units but only 150 code points → accepted.
    ;(rejectBinding as Mock).mockResolvedValue({ rejected: 1, reason: 'rejected' })
    const ok = await post(rejectPOST, 'reject', { pendingId: PENDING_ID, reason: '😀'.repeat(150) })
    expect(ok.status).toBe(200)
  })

  it.each([
    ['pending_not_found', 404],
    ['pending_not_pending', 409],
  ] as const)('typed reason %s → %i', async (reason, status) => {
    ;(rejectBinding as Mock).mockResolvedValue({ rejected: 0, reason })
    const res = await post(rejectPOST, 'reject', { pendingId: PENDING_ID, reason: 'duplicate' })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ ok: false, reason })
  })

  it('service throw → 500 generic', async () => {
    ;(rejectBinding as Mock).mockRejectedValue(new Error('boom'))
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(rejectPOST, 'reject', { pendingId: PENDING_ID, reason: 'duplicate' })
    expect(res.status).toBe(500)
    spy.mockRestore()
  })
})
