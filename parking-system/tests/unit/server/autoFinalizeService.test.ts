import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'

// settle is mocked — this slice never re-implements Phase 2 settlement; it only orchestrates
// settle → finalize per stale event. The service imports settle relatively, but vitest keys
// the mock by resolved path so `@/server/services/settlementService` still intercepts it.
vi.mock('@/server/services/settlementService', () => ({ settle: vi.fn() }))

import {
  autoFinalizeStaleEvents,
  resolveGraceDays,
  taipeiBusinessCutoff,
} from '@/server/services/autoFinalizeService'
import { settle } from '@/server/services/settlementService'

const summary = (over: Partial<{ releasedNow: number; settled: number }> = {}) => ({
  releasedNow: 0,
  settled: 0,
  penaltiesApplied: 0,
  alertsCreated: 0,
  ...over,
})

const openEvent = (id: string, sunday: string) => ({ id, sunday_date: sunday, status: 'open' as const })

describe('taipeiBusinessCutoff', () => {
  it('uses the Asia/Taipei calendar day, not UTC midnight', () => {
    // UTC 2026-06-30T17:00Z is already 2026-07-01 in Taipei (UTC+8) → cutoff = 07-01 − 2.
    expect(taipeiBusinessCutoff(new Date('2026-06-30T17:00:00Z'), 2)).toBe('2026-06-29')
  })

  it('subtracts the grace window across a month boundary', () => {
    expect(taipeiBusinessCutoff(new Date('2026-03-01T20:00:00Z'), 2)).toBe('2026-02-28')
  })

  it('subtracts across a year boundary', () => {
    expect(taipeiBusinessCutoff(new Date('2026-01-01T20:00:00Z'), 3)).toBe('2025-12-30')
  })
})

describe('resolveGraceDays', () => {
  const saved = process.env.AUTO_FINALIZE_GRACE_DAYS
  afterEach(() => {
    if (saved === undefined) delete process.env.AUTO_FINALIZE_GRACE_DAYS
    else process.env.AUTO_FINALIZE_GRACE_DAYS = saved
  })

  it('throws on a non-integer or < 1 explicit input', () => {
    expect(() => resolveGraceDays(0)).toThrow('invalid graceDays')
    expect(() => resolveGraceDays(1.5)).toThrow('invalid graceDays')
    expect(() => resolveGraceDays(-1)).toThrow('invalid graceDays')
    expect(() => resolveGraceDays(Number.NaN)).toThrow('invalid graceDays')
  })

  it('honours a valid explicit input', () => {
    expect(resolveGraceDays(1)).toBe(1)
    expect(resolveGraceDays(4)).toBe(4)
  })

  it('falls back to the default (2) for missing/invalid env, never Number(x)||default', () => {
    delete process.env.AUTO_FINALIZE_GRACE_DAYS
    expect(resolveGraceDays()).toBe(2)
    process.env.AUTO_FINALIZE_GRACE_DAYS = ''
    expect(resolveGraceDays()).toBe(2)
    process.env.AUTO_FINALIZE_GRACE_DAYS = 'abc'
    expect(resolveGraceDays()).toBe(2)
    process.env.AUTO_FINALIZE_GRACE_DAYS = '0'
    expect(resolveGraceDays()).toBe(2)
  })

  it('reads a valid integer env var', () => {
    process.env.AUTO_FINALIZE_GRACE_DAYS = '3'
    expect(resolveGraceDays()).toBe(3)
  })
})

describe('autoFinalizeStaleEvents', () => {
  let repo: MockRepo
  const savedEnv = process.env.AUTO_FINALIZE_GRACE_DAYS

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.AUTO_FINALIZE_GRACE_DAYS
    repo = makeMockRepo()
    ;(settle as Mock).mockResolvedValue(summary())
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.AUTO_FINALIZE_GRACE_DAYS
    else process.env.AUTO_FINALIZE_GRACE_DAYS = savedEnv
  })

  it('scans with the derived cutoff (Taipei day − grace)', async () => {
    repo.getStaleOpenEvents.mockResolvedValue([])
    await autoFinalizeStaleEvents({ now: new Date('2026-07-01T00:00:00Z'), graceDays: 2 }, asRepo(repo))
    expect(repo.getStaleOpenEvents).toHaveBeenCalledWith('2026-06-29')
  })

  it('applies the env grace window when no explicit grace is passed', async () => {
    process.env.AUTO_FINALIZE_GRACE_DAYS = '3'
    repo.getStaleOpenEvents.mockResolvedValue([])
    await autoFinalizeStaleEvents({ now: new Date('2026-07-01T00:00:00Z') }, asRepo(repo))
    expect(repo.getStaleOpenEvents).toHaveBeenCalledWith('2026-06-28')
  })

  it('settles then finalizes each event, in that order, passing the same now', async () => {
    const now = new Date('2099-06-01T03:00:00Z')
    repo.getStaleOpenEvents.mockResolvedValue([openEvent('e1', '2099-05-17'), openEvent('e2', '2099-05-24')])
    ;(settle as Mock).mockResolvedValue(summary({ releasedNow: 3, settled: 1 }))

    const res = await autoFinalizeStaleEvents({ now, graceDays: 2 }, asRepo(repo))

    expect(settle).toHaveBeenNthCalledWith(1, { eventId: 'e1', now }, expect.anything())
    expect(settle).toHaveBeenNthCalledWith(2, { eventId: 'e2', now }, expect.anything())
    expect(repo.finalizeWeeklyEvent).toHaveBeenNthCalledWith(1, 'e1')
    expect(repo.finalizeWeeklyEvent).toHaveBeenNthCalledWith(2, 'e2')
    // settle for e1 runs before finalize for e1
    expect((settle as Mock).mock.invocationCallOrder[0]).toBeLessThan(
      repo.finalizeWeeklyEvent.mock.invocationCallOrder[0],
    )
    expect(res).toEqual({
      scanned: 2,
      finalized: 2,
      failed: 0,
      results: [
        { eventId: 'e1', sunday_date: '2099-05-17', releasedNow: 3, settled: 1, finalized: true },
        { eventId: 'e2', sunday_date: '2099-05-24', releasedNow: 3, settled: 1, finalized: true },
      ],
    })
    // no sensitive summary fields leak into the per-event result
    for (const forbidden of ['penaltiesApplied', 'alertsCreated', 'penalty', 'pastoral']) {
      expect(Object.keys(res.results[0])).not.toContain(forbidden)
    }
  })

  it('isolates a per-event failure and keeps processing the rest', async () => {
    repo.getStaleOpenEvents.mockResolvedValue([openEvent('bad', '2099-05-17'), openEvent('ok', '2099-05-24')])
    repo.finalizeWeeklyEvent.mockImplementation(async (id: string) => {
      if (id === 'bad') throw new Error('finalize boom')
    })

    const res = await autoFinalizeStaleEvents({ now: new Date('2099-06-01T03:00:00Z'), graceDays: 2 }, asRepo(repo))

    expect(res.scanned).toBe(2)
    expect(res.finalized).toBe(1)
    expect(res.failed).toBe(1)
    expect(res.results[0]).toMatchObject({ eventId: 'bad', finalized: false, error: 'finalize boom' })
    expect(res.results[1]).toMatchObject({ eventId: 'ok', finalized: true })
  })

  it('isolates a settle failure too (finalize not attempted for that event)', async () => {
    repo.getStaleOpenEvents.mockResolvedValue([openEvent('bad', '2099-05-17')])
    ;(settle as Mock).mockRejectedValueOnce(new Error('settle boom'))

    const res = await autoFinalizeStaleEvents({ now: new Date('2099-06-01T03:00:00Z'), graceDays: 2 }, asRepo(repo))

    expect(res.results[0]).toMatchObject({ finalized: false, error: 'settle boom' })
    expect(repo.finalizeWeeklyEvent).not.toHaveBeenCalled()
  })

  it('returns zeros when nothing is stale', async () => {
    repo.getStaleOpenEvents.mockResolvedValue([])
    const res = await autoFinalizeStaleEvents({ now: new Date('2099-06-01T03:00:00Z'), graceDays: 2 }, asRepo(repo))
    expect(res).toEqual({ scanned: 0, finalized: 0, failed: 0, results: [] })
    expect(settle).not.toHaveBeenCalled()
  })

  it('rejects an invalid explicit grace window before touching the repo', async () => {
    await expect(
      autoFinalizeStaleEvents({ now: new Date('2099-06-01T03:00:00Z'), graceDays: 0 }, asRepo(repo)),
    ).rejects.toThrow('invalid graceDays')
    expect(repo.getStaleOpenEvents).not.toHaveBeenCalled()
  })
})
