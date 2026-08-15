import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Wave 3 (#9) — countOpenPastoralAlerts through the REAL repository, so the actual
// PostgREST head/count query (not a raw-SQL re-derivation) is what's under test.
// Gated: `RUN_DB_TESTS=1` + local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

const NOW = new Date('2099-09-06T02:00:00Z')
// Fresh Sunday, no collision with other integration files.
const SUNDAY = '2099-09-06'
const T = randomUUID().slice(0, 8)

// The count is table-global, so assert DELTAS against a baseline measured at the start —
// robust to any rows left by earlier (serial) suites. fileParallelism:false guarantees
// nothing else mutates the table during this file.
describe.skipIf(!RUN)('countOpenPastoralAlerts (Wave 3 #9) — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  const eventId = randomUUID()
  const adminId = randomUUID()
  const createdUsers: string[] = []

  const mkUser = async (name: string): Promise<string> => {
    const id = randomUUID()
    await sb.from('users').insert({ id, display_name: name }).throwOnError()
    createdUsers.push(id)
    return id
  }
  const mkOpenAlert = async (userId: string): Promise<string> => {
    const id = randomUUID()
    await sb.from('pastoral_care_alerts')
      .insert({ id, user_id: userId, weekly_event_id: eventId, reason: 'consecutive_no_show', trigger_count: 4 })
      .throwOnError()
    return id
  }

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    await sb.from('weekly_events')
      .insert({ id: eventId, sunday_date: SUNDAY, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0 })
      .throwOnError()
    await sb.from('admin_accounts')
      .insert({ id: adminId, username: `todos-${T}`, password_hash: 'scrypt$00$00' })
      .throwOnError()
  })

  afterAll(async () => {
    if (!RUN) return
    for (const uid of createdUsers) {
      await sb.from('pastoral_care_alerts').delete().eq('user_id', uid)
      await sb.from('user_penalties').delete().eq('user_id', uid)
      await sb.from('users').delete().eq('id', uid)
    }
    await sb.from('weekly_events').delete().eq('id', eventId)
    await sb.from('admin_accounts').delete().eq('id', adminId)
  })

  it('counts open alerts and excludes resolved ones', async () => {
    const baseline = await repo.countOpenPastoralAlerts()

    // 3 open alerts (one-open-per-user partial unique ⇒ three distinct users).
    const u1 = await mkUser(`測試甲-${T}`)
    const u2 = await mkUser(`測試乙-${T}`)
    const u3 = await mkUser(`測試丙-${T}`)
    const a1 = await mkOpenAlert(u1)
    await mkOpenAlert(u2)
    await mkOpenAlert(u3)

    expect(await repo.countOpenPastoralAlerts()).toBe(baseline + 3)

    // Resolving one drops it from the count; the row still exists (status='resolved').
    const res = await repo.resolvePastoralAlert({
      alertId: a1, adminId, note: null, resetCounter: false, nowIso: NOW.toISOString(),
    })
    expect(res.resolved).toBe(1)
    expect(await repo.countOpenPastoralAlerts()).toBe(baseline + 2)
  })

  it('listEligibilityTodoCandidates: minimal projection, superset filter, exact via pagination', async () => {
    const { p2ReviewCount } = await import('@/server/services/adminTodoService')
    const TODAY = '2099-09-06'
    // Distinct outcomes at the today boundary. mkElig sets review_status so p2_eligible reflects it.
    const mkElig = async (over: {
      approved?: boolean; valid_until?: string | null; review_date?: string | null; valid_from?: string | null
    }): Promise<string> => {
      const uid = await mkUser(`elig-${T}`)
      await sb.from('user_eligibility').insert({
        user_id: uid,
        review_status: over.approved === false ? 'unreviewed' : 'approved',
        p2_reason: over.approved === false ? null : 'mobility_short',
        p2_valid_from: over.valid_from ?? null,
        p2_valid_until: over.valid_until ?? null,
        p2_review_date: over.review_date ?? null,
      }).throwOnError()
      return uid
    }
    const expired = await mkElig({ valid_until: '2099-09-05' })                                   // < today → in, expired
    const boundary = await mkElig({ valid_until: '2099-09-06' })                                  // == today → NOT a candidate
    const reviewDue = await mkElig({ review_date: '2099-09-06' })                                 // <= today → in, review_due
    const notYet = await mkElig({ valid_from: '2099-09-20', valid_until: '2099-10-01', review_date: '2099-09-01' }) // candidate, classifier excludes
    const nonElig = await mkElig({ approved: false, valid_until: '2099-09-05' })                  // p2_eligible false → NOT a candidate
    const bothDue = await mkElig({ valid_until: '2099-09-03', review_date: '2099-09-04' })        // in, expired, counted once
    const mine = new Set([expired, boundary, reviewDue, notYet, nonElig, bothDue])

    // pageSize=2 forces the pagination loop across multiple pages (table is global).
    const rows = await repo.listEligibilityTodoCandidates(TODAY, 2)
    const mineRows = rows.filter(r => mine.has(r.user_id))

    // Superset membership: the four date-qualifying rows are present; boundary + non-eligible excluded.
    const ids = new Set(mineRows.map(r => r.user_id))
    expect(ids).toEqual(new Set([expired, reviewDue, notYet, bothDue]))

    // Minimal projection: no display_name / p2_reason / reviewed_at leak onto the hot path.
    expect(Object.keys(mineRows[0]).sort()).toEqual(['p2_review_date', 'p2_valid_from', 'p2_valid_until', 'user_id'])

    // Classifier is the authority: not_yet_effective is filtered out of the final count.
    expect(p2ReviewCount(mineRows, TODAY)).toBe(3) // expired, reviewDue, bothDue
  })
})
