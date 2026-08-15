import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Phase 4 Slice D — the release sweep notifies the member whose OWN seat was released.
// Gated: `RUN_DB_TESTS=1` + reachable local Supabase (prereq: `npm run db:reset`).
try {
  process.loadEnvFile('.env.local')
} catch {
  /* env may already be exported */
}
const RUN = process.env.RUN_DB_TESTS === '1'

type Sb = import('@supabase/supabase-js').SupabaseClient

// Seeded member/vehicle pairs (supabase/seed.sql); all penalties start at 0.
const M1 = 'a0000000-0000-0000-0000-000000000001', V1 = 'b0000000-0000-0000-0000-000000000001'
const M2 = 'a0000000-0000-0000-0000-000000000002', V2 = 'b0000000-0000-0000-0000-000000000002'
const M3 = 'a0000000-0000-0000-0000-000000000003', V3 = 'b0000000-0000-0000-0000-000000000003'
const M4 = 'a0000000-0000-0000-0000-000000000004', V4 = 'b0000000-0000-0000-0000-000000000004'
const M5 = 'a0000000-0000-0000-0000-000000000005', V5 = 'b0000000-0000-0000-0000-000000000005'

describe.skipIf(!RUN)('release owner notice — local DB integration', () => {
  let sb: Sb
  let repo: import('@/server/repositories/parkingRepository').ParkingRepository
  let runRelease: typeof import('@/server/services/releaseService').runRelease

  const SUNDAY = '2099-11-01'
  const event = randomUUID()
  // rP3/rP2 = approved past deadline (released); wM1 = waiting; tempM4 = temp_approved; attM5 = attended.
  const rP3 = randomUUID(), rP2 = randomUUID(), wM1 = randomUUID(), tempM4 = randomUUID(), attM5 = randomUUID()

  // Sunday 2099-11-01 release deadlines (Taipei): p3 10:30 = 02:30Z, p2 10:30 = 02:30Z (#42).
  let DL: { p3: Date; p2: Date; p2Grace: Date }
  const T_1046 = new Date('2099-11-01T02:46:00Z')  // past both p3 and p2 → releases rP3 + rP2
  const T_1200 = new Date('2099-11-01T04:00:00Z')  // later sweep for the idempotency check

  async function cascadeDelete(eid: string) {
    await sb.from('notification_outbox').delete().eq('weekly_event_id', eid)
    await sb.from('reservations').delete().eq('weekly_event_id', eid)
    await sb.from('weekly_events').delete().eq('id', eid)
  }
  const outbox = async () =>
    ((await sb.from('notification_outbox')
      .select('dedupe_key, template_key, user_id, reservation_id, payload_json')
      .eq('weekly_event_id', event)).data ?? [])

  beforeAll(async () => {
    const { getServiceClient } = await import('@/lib/supabase/server')
    const { createParkingRepository } = await import('@/server/repositories/parkingRepository')
    const { buildReleaseDeadlines } = await import('@/lib/allocation/release')
    runRelease = (await import('@/server/services/releaseService')).runRelease
    sb = getServiceClient()
    repo = createParkingRepository(sb)
    DL = buildReleaseDeadlines(SUNDAY)

    const { data: leftovers } = await sb.from('weekly_events').select('id').eq('sunday_date', SUNDAY)
    for (const row of leftovers ?? []) await cascadeDelete(row.id as string)

    await sb.from('weekly_events').insert({
      id: event, sunday_date: SUNDAY, total_capacity: 23, blocked_spaces: 0, admin_reserved: 0,
    }).throwOnError()

    await sb.from('reservations').insert([
      { id: rP3, weekly_event_id: event, user_id: M3, vehicle_id: V3, effective_priority: 3, status: 'approved', allocation_order: 1, release_deadline_at: DL.p3.toISOString() },
      { id: rP2, weekly_event_id: event, user_id: M2, vehicle_id: V2, effective_priority: 2, status: 'approved', allocation_order: 2, release_deadline_at: DL.p2.toISOString() },
      { id: wM1, weekly_event_id: event, user_id: M1, vehicle_id: V1, effective_priority: 3, status: 'waiting', allocation_order: 3 },
      { id: tempM4, weekly_event_id: event, user_id: M4, vehicle_id: V4, effective_priority: 3, status: 'temp_approved', allocation_order: 4 },
      { id: attM5, weekly_event_id: event, user_id: M5, vehicle_id: V5, effective_priority: 3, status: 'attended', allocation_order: 5, attended_at: T_1046.toISOString() },
    ]).throwOnError()
  })

  afterAll(async () => {
    if (sb) await cascadeDelete(event)
  })

  it('notifies each released owner exactly once, and no one else', async () => {
    const res = await runRelease({ eventId: event, now: T_1046 }, repo)
    expect(res.released).toBe(2)                 // rP3 + rP2
    expect(res.ownerNoticesEnqueued).toBe(2)     // one per released owner
    expect(res.broadcastEnqueued).toBe(1)        // only wM1 still waiting

    const rows = await outbox()
    const owner = rows.filter(r => r.template_key === 'reservation_released')
    expect(owner).toHaveLength(2)

    // Each owner notice targets the released reservation's own owner, keyed once-per-reservation.
    const byRes = new Map(owner.map(o => [o.reservation_id, o]))
    expect(byRes.get(rP3)?.user_id).toBe(M3)
    expect(byRes.get(rP3)?.dedupe_key).toBe(`released_owner:${rP3}`)
    expect(byRes.get(rP2)?.user_id).toBe(M2)
    expect(byRes.get(rP2)?.dedupe_key).toBe(`released_owner:${rP2}`)

    // Never to the temp_approved, the attended, or the waiting rows.
    const ownerResIds = owner.map(o => o.reservation_id)
    expect(ownerResIds).not.toContain(tempM4)
    expect(ownerResIds).not.toContain(attM5)
    expect(ownerResIds).not.toContain(wM1)
  })

  // This is the authority for the rule: the release sweep is the one path that fans out to many
  // members in a single batch, so its payload stays free of per-member data — defence in depth
  // against a batch ever pairing the wrong row with the wrong member.
  //
  // Wave 1d (#27) added `sunday_date`, which is event-level, not per-member, and is the same
  // value for every row in the sweep — the rule is unchanged and the prohibition below is
  // untouched. It is why reservation_released is excluded from PLATE_TEMPLATES in
  // server/services/notification/context.ts while five other member templates carry a plate.
  it('payload is aggregate-safe: no per-member fields', async () => {
    const owner = (await outbox()).filter(r => r.template_key === 'reservation_released')
    for (const o of owner) {
      const payload = o.payload_json as Record<string, unknown>
      expect(Object.keys(payload).sort()).toEqual(['released_at', 'sunday_date'])
      const json = JSON.stringify(payload)
      for (const k of ['license_plate', 'plate', 'name', 'phone', 'penalty', 'line_id', 'user_id']) {
        expect(json).not.toContain(k)
      }
    }
  })

  it('is idempotent: a later sweep enqueues no duplicate owner notice', async () => {
    const before = (await outbox()).filter(r => r.template_key === 'reservation_released').length
    const again = await runRelease({ eventId: event, now: T_1200 }, repo)
    expect(again.released).toBe(0)               // both already released_late
    expect(again.ownerNoticesEnqueued).toBe(0)   // dedupe_key collides → ON CONFLICT DO NOTHING
    const after = (await outbox()).filter(r => r.template_key === 'reservation_released').length
    expect(after).toBe(before)
  })
})
