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

describe.skipIf(!RUN)('walk-in registration — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let registerWalkIn: typeof import('@/server/services/walkInService').registerWalkIn

  const SUNDAY = '2099-04-01'
  const event = randomUUID()
  const NOW = new Date('2099-04-01T02:00:00Z')

  async function cascadeDelete(eid: string) {
    await sb.from('reservations').delete().eq('weekly_event_id', eid)
    await sb.from('weekly_events').delete().eq('id', eid)
  }
  const viewRows = async () =>
    (await sb.from('staff_checkin_view').select('*').eq('weekly_event_id', event)).data ?? []
  const walkInRows = async () =>
    (await sb.from('reservations').select('*').eq('weekly_event_id', event).eq('status', 'walk_in')).data ?? []

  beforeAll(async () => {
    sb = (await import('@/lib/supabase/server')).getServiceClient()
    repo = (await import('@/server/repositories/parkingRepository')).createParkingRepository(sb)
    registerWalkIn = (await import('@/server/services/walkInService')).registerWalkIn

    const { data } = await sb.from('weekly_events').select('id').eq('sunday_date', SUNDAY)
    for (const row of data ?? []) await cascadeDelete(row.id as string)

    await sb
      .from('weekly_events')
      .insert({ id: event, sunday_date: SUNDAY, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0 })
      .throwOnError()

    // An approved member reservation whose vehicle plate is 'GHI-9012' (for the
    // member-plate precheck test). approved requires a non-null release_deadline_at.
    await sb
      .from('reservations')
      .insert({
        weekly_event_id: event,
        user_id: M3,
        vehicle_id: V3,
        effective_priority: 3,
        status: 'approved',
        allocation_order: 1,
        release_deadline_at: '2099-04-01T02:30:00Z',
      })
      .throwOnError()
  })

  afterAll(async () => {
    if (RUN) await cascadeDelete(event)
  })

  it('creates a walk-in that appears in staff_checkin_view as present', async () => {
    const result = await registerWalkIn({ eventId: event, plate: 'WALK-1', name: '散客甲', now: NOW }, repo)

    expect(result.created).toBe(true)
    if (!result.created) return
    expect(result.row.status).toBe('walk_in')
    expect(result.row.walk_in_license_plate).toBe('WALK-1')
    expect(result.row.attended_at).not.toBeNull()
    expect(result.row.is_priority).toBe(false)

    const inView = (await viewRows()).find(r => r.walk_in_license_plate === 'WALK-1')
    expect(inView).toBeTruthy()
    expect(inView!.status).toBe('walk_in')
    expect(inView!.attended_at).not.toBeNull()
  })

  it('rejects a normalized-duplicate walk-in plate (no second row)', async () => {
    const first = await registerWalkIn({ eventId: event, plate: 'DUP-1234', now: NOW }, repo)
    expect(first.created).toBe(true)

    const dup = await registerWalkIn({ eventId: event, plate: 'dup1234', now: NOW }, repo)
    expect(dup).toEqual({ created: false, duplicate: true })

    const matches = (await walkInRows()).filter(
      r => (r.walk_in_license_plate as string).toUpperCase().replace(/[^A-Z0-9]/g, '') === 'DUP1234',
    )
    expect(matches).toHaveLength(1)
  })

  it('rejects a plate that matches an approved MEMBER vehicle (precheck covers members)', async () => {
    const result = await registerWalkIn({ eventId: event, plate: 'ghi 9012', now: NOW }, repo)
    expect(result).toEqual({ created: false, duplicate: true })

    const created = (await walkInRows()).some(
      r => (r.walk_in_license_plate as string).toUpperCase().replace(/[^A-Z0-9]/g, '') === 'GHI9012',
    )
    expect(created).toBe(false)
  })

  it('the Staff-safe view never exposes sensitive columns', async () => {
    const cols = Object.keys((await viewRows())[0] ?? {})
    for (const forbidden of ['user_id', 'vehicle_id', 'effective_priority', 'penalty_score', 'release_deadline_at', 'p2_on_the_way']) {
      expect(cols).not.toContain(forbidden)
    }
  })
})
