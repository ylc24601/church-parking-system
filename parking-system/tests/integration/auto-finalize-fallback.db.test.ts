import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

// Distinct seeded member+vehicle per event: a member may hold only one active reservation
// globally, so reusing one across several open approved reservations would collide.
const M1 = 'a0000000-0000-0000-0000-000000000001'
const V1 = 'b0000000-0000-0000-0000-000000000001'
const M2 = 'a0000000-0000-0000-0000-000000000002'
const V2 = 'b0000000-0000-0000-0000-000000000002'
const M3 = 'a0000000-0000-0000-0000-000000000003'
const V3 = 'b0000000-0000-0000-0000-000000000003'

// Fresh Sundays — must not collide with other integration files.
const STALE_A = '2099-05-17'
const STALE_B = '2099-05-24'
const RECENT = '2099-06-07' // after the cutoff → must NOT be swept
const ALL_SUNDAYS = [STALE_A, STALE_B, RECENT]

// now = 2099-06-01T03:00Z → Taipei day 2099-06-01; grace 2 → cutoff 2099-05-30.
const NOW = new Date('2099-06-01T03:00:00Z')
const CUTOFF = '2099-05-30'

describe.skipIf(!RUN)('auto-finalize fallback — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let autoFinalizeStaleEvents: typeof import('@/server/services/autoFinalizeService').autoFinalizeStaleEvents

  const eventA = randomUUID()
  const eventB = randomUUID()
  const eventRecent = randomUUID()
  // Pre-existing open weeks before the cutoff (e.g. the seed's 2026-06-21) would also be
  // swept — park them as 'finalized' for the duration so our scan is deterministic, then
  // restore them so we don't mutate shared seed state for later test files.
  let parked: string[] = []

  async function cascadeDelete(eid: string) {
    await sb.from('reservations').delete().eq('weekly_event_id', eid)
    await sb.from('weekly_events').delete().eq('id', eid)
  }
  const statusOf = async (eid: string) =>
    (await sb.from('weekly_events').select('status').eq('id', eid).single()).data?.status

  async function seedEvent(eid: string, sunday: string, userId: string, vehicleId: string) {
    await sb
      .from('weekly_events')
      .insert({ id: eid, sunday_date: sunday, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0 })
      .throwOnError()
    // Approved member reservation past its deadline → settle's release sweep moves it to
    // released_late, then no_show.
    await sb
      .from('reservations')
      .insert({
        weekly_event_id: eid,
        user_id: userId,
        vehicle_id: vehicleId,
        effective_priority: 3,
        status: 'approved',
        allocation_order: 1,
        release_deadline_at: `${sunday}T02:30:00Z`,
      })
      .throwOnError()
  }

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    autoFinalizeStaleEvents = (await import('@/server/services/autoFinalizeService')).autoFinalizeStaleEvents

    for (const sunday of ALL_SUNDAYS) {
      const { data } = await sb.from('weekly_events').select('id').eq('sunday_date', sunday)
      for (const row of data ?? []) await cascadeDelete(row.id as string)
    }

    // Park any pre-existing open week before the cutoff so the scan is deterministic.
    const { data: preOpen } = await sb
      .from('weekly_events')
      .select('id')
      .eq('status', 'open')
      .lt('sunday_date', CUTOFF)
    parked = (preOpen ?? []).map(r => r.id as string)
    if (parked.length > 0) {
      await sb.from('weekly_events').update({ status: 'finalized' }).in('id', parked).throwOnError()
    }

    await seedEvent(eventA, STALE_A, M1, V1)
    await seedEvent(eventB, STALE_B, M2, V2)
    await seedEvent(eventRecent, RECENT, M3, V3)
  })

  afterAll(async () => {
    if (!RUN) return
    await cascadeDelete(eventA)
    await cascadeDelete(eventB)
    await cascadeDelete(eventRecent)
    if (parked.length > 0) {
      await sb.from('weekly_events').update({ status: 'open' }).in('id', parked)
    }
  })

  it('sweeps only the past-cutoff open weeks, settling + finalizing each', async () => {
    const res = await autoFinalizeStaleEvents({ now: NOW, graceDays: 2 }, repo)

    expect(res.scanned).toBe(2)
    expect(res.finalized).toBe(2)
    expect(res.failed).toBe(0)
    for (const r of res.results) {
      expect(r.finalized).toBe(true)
      expect(r.settled).toBeGreaterThanOrEqual(1)
    }
    expect(await statusOf(eventA)).toBe('finalized')
    expect(await statusOf(eventB)).toBe('finalized')
    // The recent (post-cutoff) week is untouched.
    expect(await statusOf(eventRecent)).toBe('open')
  })

  it('is idempotent — a second run finds nothing still open', async () => {
    const res = await autoFinalizeStaleEvents({ now: NOW, graceDays: 2 }, repo)
    expect(res.scanned).toBe(0)
    expect(res.results).toEqual([])
    expect(await statusOf(eventRecent)).toBe('open')
  })
})
