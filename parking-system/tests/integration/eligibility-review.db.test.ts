import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listEligibilityReview } from '@/server/services/eligibilityReviewService'

// Phase 8 Slice 4 — P2 eligibility review, against local Supabase. Exercises the
// repo's two date-ordered branches + distinct merge and the service's dueDate/status
// classification. Gated: `RUN_DB_TESTS=1` (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

// Letters-only isolation tag so a display_name filter is unambiguous.
const TAG = randomUUID().replace(/[0-9-]/g, '').slice(0, 6).toUpperCase()

// Fixed clock: taipeiToday(NOW) === '2099-06-01'; cutoff === '2099-07-31'.
const NOW = new Date('2099-06-01T00:00:00Z')

describe.skipIf(!RUN)('eligibility review (Phase 8 Slice 4) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  const ids: string[] = []

  // review_status is the authority since 0032 — p2_eligible is generated from it and the
  // DB rejects any attempt to write it ("can only be updated to DEFAULT").
  const mkMember = async (
    label: string,
    elig: {
      review_status: 'unreviewed' | 'approved' | 'revoked'
      p2_reason: string | null
      p2_valid_until: string | null
      p2_review_date: string | null
    },
  ) => {
    const id = randomUUID()
    await sb.from('users').insert({ id, display_name: `${TAG}${label}` }).throwOnError()
    ids.push(id)
    await sb.from('user_eligibility').insert({ user_id: id, ...elig }).throwOnError()
    return id
  }

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
  })

  afterAll(async () => {
    if (!RUN) return
    for (const id of ids) {
      await sb.from('user_eligibility').delete().eq('user_id', id)
      await sb.from('users').delete().eq('id', id)
    }
  })

  it('surfaces expired / review-required / upcoming (incl. min-date), excludes permanent / far / non-eligible', async () => {
    // Insert in an order deliberately REVERSED from due-date order to prove the sort.
    await mkMember('Far', { review_status: 'approved', p2_reason: 'mobility_short', p2_valid_until: '2099-12-01', p2_review_date: '2099-12-01' })
    await mkMember('Perm', { review_status: 'approved', p2_reason: 'mobility_long', p2_valid_until: null, p2_review_date: null })
    // NOT eligible because nobody has ever reviewed them — which is precisely why 0032's
    // enum needed a neutral 'unreviewed' rather than folding this into 'revoked'. Calling
    // this member revoked would claim a 幹事 took something away that they never had.
    await mkMember('NotElig', { review_status: 'unreviewed', p2_reason: null, p2_valid_until: null, p2_review_date: null })
    await mkMember('Upcoming', { review_status: 'approved', p2_reason: 'child_companion', p2_valid_until: '2099-07-01', p2_review_date: '2099-07-01' })
    // Inconsistent row: valid_until EARLIER than review_date → dueDate must be valid_until.
    await mkMember('Inconsistent', { review_status: 'approved', p2_reason: 'mobility_short', p2_valid_until: '2099-06-15', p2_review_date: '2099-07-20' })
    await mkMember('ReviewReq', { review_status: 'approved', p2_reason: 'mobility_short', p2_valid_until: null, p2_review_date: '2099-05-30' })
    await mkMember('Expired', { review_status: 'approved', p2_reason: 'mobility_short', p2_valid_until: '2099-05-31', p2_review_date: '2099-05-31' })

    const { items } = await listEligibilityReview(repo, NOW)
    const mine = items.filter(i => i.displayName.startsWith(TAG))

    // Only the four due/expiring rows, sorted by dueDate ascending.
    expect(mine.map(i => i.displayName)).toEqual([
      `${TAG}ReviewReq`,     // 2099-05-30 (review_due)
      `${TAG}Expired`,       // 2099-05-31 (expired)
      `${TAG}Inconsistent`,  // 2099-06-15 (min of the two dates)
      `${TAG}Upcoming`,      // 2099-07-01 (upcoming)
    ])

    const byName = (n: string) => mine.find(i => i.displayName === `${TAG}${n}`)!
    expect(byName('Expired').status).toBe('expired')
    expect(byName('ReviewReq').status).toBe('review_due')
    expect(byName('Upcoming').status).toBe('upcoming')
    // The inconsistent row's dueDate is the earlier valid_until, not the later review_date.
    expect(byName('Inconsistent').dueDate).toBe('2099-06-15')
    expect(byName('Inconsistent').status).toBe('upcoming')

    // Excluded categories never appear.
    for (const excluded of ['Far', 'Perm', 'NotElig']) {
      expect(mine.some(i => i.displayName === `${TAG}${excluded}`)).toBe(false)
    }
  })

  it('a row whose both dates satisfy the cutoff (hits both branches) appears exactly once', async () => {
    const { items } = await listEligibilityReview(repo, NOW)
    const upcoming = items.filter(i => i.displayName === `${TAG}Upcoming`)
    expect(upcoming).toHaveLength(1)
  })

  it('repo branches carry the joined display_name and both dates', async () => {
    const rows = await repo.listEligibilityReview({ cutoffDate: '2099-07-31', branchCap: 1001 })
    const expired = rows.find(r => r.display_name === `${TAG}Expired`)
    expect(expired).toBeDefined()
    expect(expired!.p2_valid_until).toBe('2099-05-31')
    expect(expired!.p2_review_date).toBe('2099-05-31')
    // Distinct by user_id: no duplicate rows for the two-branch match.
    const upcomingRows = rows.filter(r => r.display_name === `${TAG}Upcoming`)
    expect(upcomingRows).toHaveLength(1)
  })
})
