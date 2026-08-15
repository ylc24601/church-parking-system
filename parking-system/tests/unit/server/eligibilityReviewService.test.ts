import { describe, expect, it, vi } from 'vitest'
import { makeMockRepo, asRepo, type MockRepo } from './mockRepo'
import { listEligibilityReview } from '@/server/services/eligibilityReviewService'
import type { EligibilityReviewRow } from '@/server/repositories/parkingRepository'

// Fixed clock: taipeiToday(NOW) === '2026-07-12'; cutoff === today + 60 === '2026-09-10'.
const NOW = new Date('2026-07-12T00:00:00Z')
const TODAY = '2026-07-12'

function run(rows: EligibilityReviewRow[]) {
  const repo: MockRepo = makeMockRepo({ listEligibilityReview: vi.fn(async () => rows) })
  return { repo, r: asRepo(repo) }
}

const row = (over: Partial<EligibilityReviewRow>): EligibilityReviewRow => ({
  user_id: '11111111-1111-4111-8111-111111111111',
  display_name: '王小明',
  p2_reason: 'mobility_short',
  p2_valid_from: null,
  p2_valid_until: null,
  p2_review_date: null,
  reviewed_at: null,
  ...over,
})

describe('listEligibilityReview — cutoff + repo wiring', () => {
  it('passes today+60 as the cutoff and the branch cap to the repo', async () => {
    const { repo, r } = run([])
    await listEligibilityReview(r, NOW)
    expect(repo.listEligibilityReview).toHaveBeenCalledWith({ cutoffDate: '2026-09-10', branchCap: 1001 })
  })

  it('empty repo → empty result with zero counts', async () => {
    const { r } = run([])
    expect(await listEligibilityReview(r, NOW)).toEqual({ items: [], hasMore: false, counts: { expired: 0, review_due: 0, upcoming: 0 } })
  })
})

describe('listEligibilityReview — dueDate = min(valid_until, review_date)', () => {
  it('uses valid_until when it is earlier than review_date', async () => {
    const { r } = run([row({ user_id: 'x', p2_valid_until: '2026-07-20', p2_review_date: '2026-08-30' })])
    const { items } = await listEligibilityReview(r, NOW)
    expect(items[0].dueDate).toBe('2026-07-20')
    expect(items[0].status).toBe('upcoming')   // both dates in the future
  })

  it('uses review_date when it is earlier than valid_until', async () => {
    const { r } = run([row({ user_id: 'y', p2_valid_until: '2026-09-05', p2_review_date: '2026-07-15' })])
    const { items } = await listEligibilityReview(r, NOW)
    expect(items[0].dueDate).toBe('2026-07-15')
  })

  it('falls back to the single present date when the other is null', async () => {
    const { r } = run([row({ user_id: 'z', p2_valid_until: '2026-08-01', p2_review_date: null })])
    const { items } = await listEligibilityReview(r, NOW)
    expect(items[0].dueDate).toBe('2026-08-01')
  })

  it('expired takes precedence over review_due even when review_date is later', async () => {
    const { r } = run([row({ user_id: 'e', p2_valid_until: '2026-07-01', p2_review_date: '2026-08-30' })])
    const { items } = await listEligibilityReview(r, NOW)
    expect(items[0].status).toBe('expired')
    expect(items[0].dueDate).toBe('2026-07-01')
  })

  it('classifies a review-required import (valid_until null, review_date past) as review_due', async () => {
    const { r } = run([row({ user_id: 'rr', p2_valid_until: null, p2_review_date: '2026-07-11' })])
    const { items } = await listEligibilityReview(r, NOW)
    expect(items[0].status).toBe('review_due')
  })
})

describe('listEligibilityReview — global stable sort', () => {
  it('sorts by dueDate asc regardless of repo order, then displayName, then userId', async () => {
    const { r } = run([
      row({ user_id: 'b', display_name: '陳一', p2_valid_until: '2026-08-01', p2_review_date: null }),
      row({ user_id: 'a2', display_name: '甲', p2_valid_until: '2026-07-20', p2_review_date: null }),
      row({ user_id: 'a1', display_name: '甲', p2_valid_until: '2026-07-20', p2_review_date: null }),
      row({ user_id: 'c', display_name: '林三', p2_valid_until: '2026-07-01', p2_review_date: null }),
    ])
    const { items } = await listEligibilityReview(r, NOW)
    // c (07-01, expired) first, then the two 07-20 rows (same name → by userId a1 < a2), then b (08-01)
    expect(items.map(i => i.userId)).toEqual(['c', 'a1', 'a2', 'b'])
  })
})

describe('listEligibilityReview — status precedence & permanent skip', () => {
  it('drops a permanent row defensively (both dates null should never come from the repo filter)', async () => {
    const { r } = run([row({ user_id: 'perm', p2_valid_until: null, p2_review_date: null })])
    const { items } = await listEligibilityReview(r, NOW)
    expect(items).toEqual([])
  })

  it('valid_until == today is upcoming, not expired', async () => {
    const { r } = run([row({ user_id: 't', p2_valid_until: TODAY, p2_review_date: null })])
    const { items } = await listEligibilityReview(r, NOW)
    expect(items[0].status).toBe('upcoming')
  })
})

describe('listEligibilityReview — hasMore + counts', () => {
  it('caps at 500 items, flags hasMore, and counts reflect the DISPLAYED items only', async () => {
    const rows = Array.from({ length: 501 }, (_, i) =>
      row({ user_id: `u${String(i).padStart(4, '0')}`, display_name: `M${i}`, p2_valid_until: null, p2_review_date: '2026-07-11' }),
    )
    const { r } = run(rows)
    const { items, hasMore, counts } = await listEligibilityReview(r, NOW)
    expect(items).toHaveLength(500)
    expect(hasMore).toBe(true)
    expect(counts.review_due).toBe(500)
    expect(counts.expired + counts.upcoming).toBe(0)
  })

  it('counts each status in a mixed set', async () => {
    const { r } = run([
      row({ user_id: 'ex', p2_valid_until: '2026-07-01', p2_review_date: null }),        // expired
      row({ user_id: 'rd', p2_valid_until: null, p2_review_date: '2026-07-10' }),         // review_due
      row({ user_id: 'up', p2_valid_until: '2026-08-15', p2_review_date: '2026-08-15' }), // upcoming
    ])
    const { counts, hasMore } = await listEligibilityReview(r, NOW)
    expect(counts).toEqual({ expired: 1, review_due: 1, upcoming: 1 })
    expect(hasMore).toBe(false)
  })
})
