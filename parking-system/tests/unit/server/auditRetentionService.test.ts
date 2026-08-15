import { afterEach, describe, expect, it, vi } from 'vitest'
import { purgeAuditLogs, readRetentionMonths } from '@/server/services/auditRetentionService'
import { asRepo, makeMockRepo } from './mockRepo'

const OK = (over: Partial<{ count: number; hasMore: boolean; deletedBefore: string; retentionMonths: number }> = {}) =>
  ({ count: 0, hasMore: false, deletedBefore: '2024-07-17T15:00:00+00:00', retentionMonths: 24, ...over })

describe('readRetentionMonths', () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  it('defaults to 24 when unset / blank', () => {
    delete process.env.AUDIT_RETENTION_MONTHS
    expect(readRetentionMonths()).toBe(24)
    process.env.AUDIT_RETENTION_MONTHS = '   '
    expect(readRetentionMonths()).toBe(24)
  })

  it('honours a longer window', () => {
    process.env.AUDIT_RETENTION_MONTHS = '36'
    expect(readRetentionMonths()).toBe(36)
  })

  it('the window can only be LENGTHENED: anything < 24 / non-integer / junk → 24', () => {
    // Floor == default on purpose. Audit has no legitimate reason to retain LESS than
    // policy, and the fail-safe direction is "keep longer", never "delete earlier".
    for (const bad of ['23', '12', '1', '0', '-5', 'abc', '24.5']) {
      process.env.AUDIT_RETENTION_MONTHS = bad
      expect(readRetentionMonths()).toBe(24)
    }
  })
})

describe('purgeAuditLogs', () => {
  const saved = { ...process.env }
  afterEach(() => { process.env = { ...saved } })

  it('dryRun DEFAULTS to true — the repo is called with dryRun:true unless explicitly false', async () => {
    const repo = makeMockRepo()
    await purgeAuditLogs({}, asRepo(repo))
    expect(repo.purgeAuditLogs).toHaveBeenCalledWith(24, 200, true, expect.any(String))
  })

  it('there is NO now parameter — the repo call carries only window/max/dryRun/requestId', async () => {
    // The DB owns the clock (0034). If a `now` ever leaks into this signature it is a
    // window bypass, so the shape is pinned: exactly four positional args, no Date.
    const repo = makeMockRepo({ purgeAuditLogs: vi.fn(async () => OK({ count: 5 })) })
    await purgeAuditLogs({ dryRun: false }, asRepo(repo))
    const call = repo.purgeAuditLogs.mock.calls[0]
    expect(call).toHaveLength(4)
    expect(call.some(a => a instanceof Date)).toBe(false)
  })

  it('dry-run returns the true total plus the DB-supplied cutoff, never recomputed here', async () => {
    const repo = makeMockRepo({
      purgeAuditLogs: vi.fn(async () => OK({ count: 137, deletedBefore: '2024-07-17T15:00:00+00:00' })),
    })
    const res = await purgeAuditLogs({ dryRun: true }, asRepo(repo))
    expect(res).toEqual({
      dryRun: true, wouldPurge: 137,
      deletedBefore: '2024-07-17T15:00:00+00:00', retentionMonths: 24,
    })
  })

  it('uses a LONGER env window when set', async () => {
    process.env.AUDIT_RETENTION_MONTHS = '36'
    const repo = makeMockRepo({ purgeAuditLogs: vi.fn(async () => OK({ retentionMonths: 36 })) })
    const res = await purgeAuditLogs({ dryRun: true }, asRepo(repo))
    expect(repo.purgeAuditLogs).toHaveBeenCalledWith(36, 200, true, expect.any(String))
    expect(res.retentionMonths).toBe(36)
  })

  it('max: default 200, hard cap 500, truncated', async () => {
    const repo = makeMockRepo()
    await purgeAuditLogs({ max: 9999 }, asRepo(repo))
    expect(repo.purgeAuditLogs).toHaveBeenLastCalledWith(24, 500, true, expect.any(String))
    await purgeAuditLogs({ max: 10.9 }, asRepo(repo))
    expect(repo.purgeAuditLogs).toHaveBeenLastCalledWith(24, 10, true, expect.any(String))
  })

  it('apply DRAINS the backlog in a bounded loop, accumulating across batches, one shared requestId', async () => {
    // Two batches with more, then a final empty-ish batch that clears has_more.
    const impl = vi.fn()
      .mockResolvedValueOnce(OK({ count: 200, hasMore: true }))
      .mockResolvedValueOnce(OK({ count: 200, hasMore: true }))
      .mockResolvedValueOnce(OK({ count: 40, hasMore: false }))
    const repo = makeMockRepo({ purgeAuditLogs: impl })
    const res = await purgeAuditLogs({ dryRun: false }, asRepo(repo))
    expect(res).toEqual({
      dryRun: false, deletedCount: 440, batches: 3, hasMore: false,
      deletedBefore: '2024-07-17T15:00:00+00:00', retentionMonths: 24,
    })
    // Same requestId threaded to every batch so the RPC's markers correlate.
    const ids = impl.mock.calls.map(c => c[3])
    expect(new Set(ids).size).toBe(1)
  })

  it('apply stops at the batch cap and reports hasMore:true so a monitor can catch the residual', async () => {
    // Always more, always deleting — must not loop forever; caps at 20 batches.
    const repo = makeMockRepo({ purgeAuditLogs: vi.fn(async () => OK({ count: 500, hasMore: true })) })
    const res = await purgeAuditLogs({ dryRun: false }, asRepo(repo))
    expect(res.dryRun).toBe(false)
    if (res.dryRun === false) {
      expect(res.batches).toBe(20)
      expect(res.deletedCount).toBe(10_000)
      expect(res.hasMore).toBe(true)
    }
    expect(repo.purgeAuditLogs).toHaveBeenCalledTimes(20)
  })

  it('apply stops when a batch makes no progress (all skip-locked), rather than spinning', async () => {
    const repo = makeMockRepo({ purgeAuditLogs: vi.fn(async () => OK({ count: 0, hasMore: true })) })
    const res = await purgeAuditLogs({ dryRun: false }, asRepo(repo))
    expect(repo.purgeAuditLogs).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({ dryRun: false, deletedCount: 0, batches: 1, hasMore: true })
  })

  it('summary is operation-safe — never leaks a deleted row id or metadata', async () => {
    const repo = makeMockRepo({ purgeAuditLogs: vi.fn(async () => OK({ count: 2 })) })
    for (const dryRun of [true, false]) {
      const json = JSON.stringify(await purgeAuditLogs({ dryRun }, asRepo(repo)))
      for (const k of ['id', 'actor_id', 'entity_id', 'metadata', 'line_id', 'phone']) {
        expect(json).not.toContain(k)
      }
    }
  })
})
