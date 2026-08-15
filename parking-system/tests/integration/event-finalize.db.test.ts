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

// Seeded member + vehicle (supabase/seed.sql): M3 drives plate 'GHI-9012'.
const M3 = 'a0000000-0000-0000-0000-000000000003'
const V3 = 'b0000000-0000-0000-0000-000000000003'
// Fresh Sunday — must not collide with other integration files (…05-03 etc.).
const SUNDAY = '2099-05-10'

describe.skipIf(!RUN)('weekly_events finalize — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let settle: typeof import('@/server/services/settlementService').settle
  const event = randomUUID()
  const NOW = new Date('2099-05-10T03:00:00Z') // after the reservation's deadline

  async function cascadeDelete(eid: string) {
    await sb.from('reservations').delete().eq('weekly_event_id', eid)
    await sb.from('weekly_events').delete().eq('id', eid)
  }
  const eventStatus = async () =>
    (await sb.from('weekly_events').select('status').eq('id', event).single()).data?.status

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    settle = (await import('@/server/services/settlementService')).settle

    const { data } = await sb.from('weekly_events').select('id').eq('sunday_date', SUNDAY)
    for (const row of data ?? []) await cascadeDelete(row.id as string)

    await sb
      .from('weekly_events')
      .insert({ id: event, sunday_date: SUNDAY, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0 })
      .throwOnError()
    // An approved member reservation past its deadline → settle's release sweep
    // moves it to released_late, then to no_show.
    await sb
      .from('reservations')
      .insert({
        weekly_event_id: event,
        user_id: M3,
        vehicle_id: V3,
        effective_priority: 3,
        status: 'approved',
        allocation_order: 1,
        release_deadline_at: '2099-05-10T02:30:00Z',
      })
      .throwOnError()
  })

  afterAll(async () => {
    if (RUN) await cascadeDelete(event)
  })

  it('settle alone does NOT finalize; finalizeWeeklyEvent closes the week', async () => {
    const summary = await settle({ eventId: event, now: NOW }, repo)
    expect(summary.settled).toBeGreaterThanOrEqual(1)
    expect(await eventStatus()).toBe('open') // settlement does not touch event status

    await repo.finalizeWeeklyEvent(event)
    expect(await eventStatus()).toBe('finalized')
  })

  it('finalizeWeeklyEvent is idempotent (re-call keeps finalized, no error)', async () => {
    await repo.finalizeWeeklyEvent(event)
    expect(await eventStatus()).toBe('finalized')
  })

  it('a finalized event is still readable (getStaffCheckInList works)', async () => {
    const rows = await repo.getStaffCheckInList(event)
    expect(Array.isArray(rows)).toBe(true) // reads allowed; settled no_show row is dropped
  })
})
