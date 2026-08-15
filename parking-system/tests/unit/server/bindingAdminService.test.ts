import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import {
  applyApproveBinding,
  issueBindingCode,
  listPendingBindings,
  listPendingBindingsPage,
  previewApproveBinding,
  rejectBinding,
} from '@/server/services/bindingAdminService'

const NOW = new Date('2026-07-05T00:00:00Z')
const RAW_LINE_ID = 'Udeadbeefdeadbeefdeadbeefdeadbeef'

function run(over: Partial<MockRepo> = {}) {
  const repo = makeMockRepo(over)
  return { repo, r: asRepo(repo) }
}

describe('issueBindingCode', () => {
  it('generates a code, computes expiry from ttl-days, and returns the full code + member name', async () => {
    const { repo, r } = run()
    const issued = await issueBindingCode({ userId: 'u1', ttlDays: 14, now: NOW }, r)
    expect(issued.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(issued.displayName).toBe('王小明')
    expect(issued.expiresAt).toBe(new Date('2026-07-19T00:00:00Z').toISOString())
    expect(repo.insertBindingCode).toHaveBeenCalledTimes(1)
    const arg = (repo.insertBindingCode as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg).toMatchObject({ code: issued.code, userId: 'u1', expiresAtIso: issued.expiresAt })
  })

  it('normalizes + validates an explicit --code, and errors on collision', async () => {
    const { r } = run({ insertBindingCode: vi.fn(async () => ({ inserted: false })) })
    await expect(issueBindingCode({ userId: 'u1', ttlDays: 7, code: ' abcd-2345 ', now: NOW }, r))
      .rejects.toThrow(/already exists/)
  })

  it('rejects a malformed explicit code', async () => {
    const { r } = run()
    await expect(issueBindingCode({ userId: 'u1', ttlDays: 7, code: 'no', now: NOW }, r)).rejects.toThrow(/--code must match/)
  })

  it('rejects a non-positive ttl and an unknown user', async () => {
    const { r } = run()
    await expect(issueBindingCode({ userId: 'u1', ttlDays: 0, now: NOW }, r)).rejects.toThrow(/ttl-days/)
    const { r: r2 } = run({ getUserDisplayName: vi.fn(async () => null) })
    await expect(issueBindingCode({ userId: 'nope', ttlDays: 7, now: NOW }, r2)).rejects.toThrow(/user_id not found/)
  })

  it('retries generation on a unique collision, then succeeds', async () => {
    let calls = 0
    const { repo, r } = run({
      insertBindingCode: vi.fn(async () => ({ inserted: ++calls >= 3 })), // first two collide
    })
    const issued = await issueBindingCode({ userId: 'u1', ttlDays: 7, now: NOW }, r)
    expect(issued.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    expect(repo.insertBindingCode).toHaveBeenCalledTimes(3)
  })
})

describe('previewApproveBinding', () => {
  it('returns masked fields + predicted reason and NEVER the raw line_user_id / full code', async () => {
    const { r } = run({
      getBindingApprovalPreview: vi.fn(async () => ({
        pending_status: 'pending',
        claim_source: 'keyword',
        line_user_id: RAW_LINE_ID,
        submitted_code: 'ABCD-2345',
        claimed_phone: null,
        claimed_name: null,
        superseded_count: 0,
        last_submitted_at: '2026-07-05T00:00:00.000Z',
        matched_user_id: 'u1',
        matched_display_name: '王小明',
      })),
      approvePendingBinding: vi.fn(async () => ({ approved: 0, would_approve: true, reason: 'approved' })),
    })
    const preview = await previewApproveBinding({ pendingId: 'p1', now: NOW }, r)
    expect(preview).toMatchObject({
      found: true, pendingStatus: 'pending', claimSource: 'keyword',
      claimVersion: 0, lineUserIdMasked: 'Udeadb…beef',
      submittedCodeMasked: 'ABCD-****', claimedPhoneMasked: null,
      matchedDisplayName: '王小明', wouldApprove: true, reason: 'approved',
    })
    const s = JSON.stringify(preview)
    expect(s).not.toContain(RAW_LINE_ID)
    expect(s).not.toContain('ABCD-2345')
  })

  it('a liff claim previews masked phone + full claimed name (admin comparison) — raw phone never surfaces', async () => {
    const { r } = run({
      getBindingApprovalPreview: vi.fn(async () => ({
        pending_status: 'pending',
        claim_source: 'liff',
        line_user_id: RAW_LINE_ID,
        submitted_code: null,
        claimed_phone: '0912345678',
        claimed_name: '王小明',
        superseded_count: 3,
        last_submitted_at: '2026-07-10T01:00:00.000Z',
        matched_user_id: 'u1',
        matched_display_name: '王小明',
      })),
      approvePendingBinding: vi.fn(async () => ({ approved: 0, would_approve: true, reason: 'approved' })),
    })
    const preview = await previewApproveBinding({ pendingId: 'p1', now: NOW }, r)
    expect(preview).toMatchObject({
      claimSource: 'liff', submittedCodeMasked: null,
      claimedPhoneMasked: '0912***678', claimedName: '王小明',
      claimVersion: 3, matchedDisplayName: '王小明',
    })
    expect(JSON.stringify(preview)).not.toContain('0912345678')
  })

  it('always calls the RPC in dry-run mode (no write)', async () => {
    const approve = vi.fn(async () => ({ approved: 0, would_approve: false, reason: 'code_expired' }))
    const { r } = run({ approvePendingBinding: approve })
    await previewApproveBinding({ pendingId: 'p1', now: NOW }, r)
    expect(approve).toHaveBeenCalledWith({ pendingId: 'p1', nowIso: NOW.toISOString(), dryRun: true })
  })

  it('reports not-found without display fields', async () => {
    const { r } = run({
      getBindingApprovalPreview: vi.fn(async () => null),
      approvePendingBinding: vi.fn(async () => ({ approved: 0, would_approve: false, reason: 'pending_not_found' })),
    })
    expect(await previewApproveBinding({ pendingId: 'x', now: NOW }, r)).toEqual({
      found: false, wouldApprove: false, reason: 'pending_not_found',
    })
  })
})

describe('applyApproveBinding', () => {
  it('calls the RPC with dryRun=false and the previewed revision (0 is valid); no adminId → null', async () => {
    const approve = vi.fn(async () => ({ approved: 1, would_approve: true, reason: 'approved' }))
    const { r } = run({ approvePendingBinding: approve })
    expect(await applyApproveBinding({ pendingId: 'p1', expectedSupersededCount: 0, now: NOW }, r))
      .toEqual({ approved: 1, reason: 'approved' })
    expect(approve).toHaveBeenCalledWith({
      pendingId: 'p1',
      nowIso: NOW.toISOString(),
      dryRun: false,
      expectedSupersededCount: 0,
      adminId: null,   // CLI decisions are unattributed
    })
  })

  it('threads the Admin-UI decider through to the repo', async () => {
    const approve = vi.fn(async () => ({ approved: 1, would_approve: true, reason: 'approved' }))
    const { r } = run({ approvePendingBinding: approve })
    await applyApproveBinding({ pendingId: 'p1', expectedSupersededCount: 2, adminId: 'admin-1', now: NOW }, r)
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ adminId: 'admin-1' }))
  })

  it('refuses an apply without a valid revision (optimistic concurrency is not optional)', async () => {
    const { r } = run()
    for (const bad of [-1, 1.5, Number.NaN]) {
      await expect(
        applyApproveBinding({ pendingId: 'p1', expectedSupersededCount: bad, now: NOW }, r),
      ).rejects.toThrow(/claimVersion/)
    }
  })
})

describe('rejectBinding', () => {
  it('trims the reason and forwards it (no adminId → null)', async () => {
    const reject = vi.fn(async () => ({ rejected: 1, reason: 'rejected' }))
    const { r } = run({ rejectPendingBinding: reject })
    expect(await rejectBinding({ pendingId: 'p1', reason: '  duplicate ', now: NOW }, r)).toEqual({ rejected: 1, reason: 'rejected' })
    expect(reject).toHaveBeenCalledWith({ pendingId: 'p1', reason: 'duplicate', nowIso: NOW.toISOString(), adminId: null })
  })
  it('threads the Admin-UI decider through to the repo', async () => {
    const reject = vi.fn(async () => ({ rejected: 1, reason: 'rejected' }))
    const { r } = run({ rejectPendingBinding: reject })
    await rejectBinding({ pendingId: 'p1', reason: 'duplicate', adminId: 'admin-1', now: NOW }, r)
    expect(reject).toHaveBeenCalledWith(expect.objectContaining({ adminId: 'admin-1' }))
  })
  it('rejects an empty reason', async () => {
    const { r } = run()
    await expect(rejectBinding({ pendingId: 'p1', reason: '   ', now: NOW }, r)).rejects.toThrow(/reason must not be empty/)
  })
  it('caps the reason at 200 CODE POINTS (matches DB char_length, not UTF-16 units)', async () => {
    const { r } = run()
    // 200 CJK chars pass …
    await expect(rejectBinding({ pendingId: 'p1', reason: '愛'.repeat(200), now: NOW }, r)).resolves.toBeDefined()
    // … 201 fail; and 101 astral chars (2 UTF-16 units each) still count as 101, not 202.
    await expect(rejectBinding({ pendingId: 'p1', reason: '愛'.repeat(201), now: NOW }, r)).rejects.toThrow(/at most 200/)
    await expect(rejectBinding({ pendingId: 'p1', reason: '😀'.repeat(101), now: NOW }, r)).resolves.toBeDefined()
  })
})

describe('listPendingBindings', () => {
  const rows = [
    {
      id: 'a1b2c3d4-0000-0000-0000-000000000001', claim_source: 'liff',
      submitted_code: null, claimed_phone: '0912345678', claimed_name: '王小明',
      created_at: '2026-07-10T00:00:00.000Z', last_submitted_at: '2026-07-10T01:00:00.000Z', superseded_count: 2,
    },
    {
      id: 'd4e5f6a7-0000-0000-0000-000000000002', claim_source: 'keyword',
      submitted_code: 'ABCD-2345', claimed_phone: null, claimed_name: null,
      created_at: '2026-07-10T02:00:00.000Z', last_submitted_at: '2026-07-10T02:00:00.000Z', superseded_count: 0,
    },
  ]

  it('masks phone/code, keeps claimed name (comparison hint), short id, retries', async () => {
    const list = vi.fn(async () => rows)
    const { r } = run({ listPendingBindings: list })
    const items = await listPendingBindings({}, r)
    expect(list).toHaveBeenCalledWith(20)   // default limit
    expect(items[0]).toMatchObject({
      shortId: 'a1b2c3d4', source: 'liff', resubmits: 2, claim: '王小明 / 0912***678',
    })
    expect(items[1]).toMatchObject({ shortId: 'd4e5f6a7', source: 'keyword', claim: 'ABCD-****' })
    const s = JSON.stringify(items)
    expect(s).not.toContain('0912345678')
    expect(s).not.toContain('ABCD-2345')
  })

  it('clamps limit to 1..100', async () => {
    const list = vi.fn(async () => [])
    const { r } = run({ listPendingBindings: list })
    await listPendingBindings({ limit: 0 }, r)
    expect(list).toHaveBeenLastCalledWith(1)
    await listPendingBindings({ limit: 9999 }, r)
    expect(list).toHaveBeenLastCalledWith(100)
  })
})

describe('listPendingBindingsPage', () => {
  const row = (n: number) => ({
    id: `a1b2c3d4-0000-0000-0000-${String(n).padStart(12, '0')}`, claim_source: 'keyword',
    submitted_code: 'ABCD-2345', claimed_phone: null, claimed_name: null,
    created_at: '2026-07-10T00:00:00.000Z', last_submitted_at: '2026-07-10T00:00:00.000Z', superseded_count: 0,
  })

  it('fetches limit+1 and reports hasMore without leaking the extra row', async () => {
    const list = vi.fn(async () => Array.from({ length: 3 }, (_, i) => row(i)))
    const { r } = run({ listPendingBindings: list })
    const page = await listPendingBindingsPage({ limit: 2 }, r)
    expect(list).toHaveBeenCalledWith(3)   // limit + 1 probe
    expect(page.items).toHaveLength(2)
    expect(page.hasMore).toBe(true)
  })

  it('hasMore=false when the probe comes back short', async () => {
    const list = vi.fn(async () => [row(1)])
    const { r } = run({ listPendingBindings: list })
    const page = await listPendingBindingsPage({ limit: 2 }, r)
    expect(page.items).toHaveLength(1)
    expect(page.hasMore).toBe(false)
  })
})
